package heartbeat

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/horcrux-file-system/horcrux/apps/node/internal/storage"
)

type testSigner struct{ key ed25519.PrivateKey }

func (signer testSigner) Sign(payload []byte) []byte { return ed25519.Sign(signer.key, payload) }

type testStats struct{ stats storage.Stats }

func (provider testStats) Stats(context.Context) (storage.Stats, error) { return provider.stats, nil }

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

func TestReporterSendsSignedCapacityPayload(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Unix(2_000_000_000, 0)
	var received Payload
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path != "/nodes/node-a/heartbeat" {
			t.Errorf("wrong heartbeat path: %s", request.URL.Path)
		}
		var body struct {
			Heartbeat string `json:"heartbeat"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		received, err = Verify(body.Heartbeat, publicKey)
		if err != nil {
			t.Error(err)
		}
		return &http.Response{StatusCode: http.StatusNoContent, Body: io.NopCloser(bytes.NewReader(nil)), Header: make(http.Header)}, nil
	})}

	reporter := Reporter{ControlPlaneURL: "https://control.example", NodeID: "node-a", NodeVersion: "0.1.0", Endpoint: "https://192.168.1.42:9443", Stats: testStats{storage.Stats{CapacityBytes: 1000, UsedBytes: 250, AvailableBytes: 750}}, Signer: testSigner{privateKey}, Client: client, Now: func() time.Time { return now }}
	if err := reporter.Report(context.Background()); err != nil {
		t.Fatal(err)
	}
	if received.NodeID != "node-a" || received.CapacityBytes != 1000 || received.UsedBytes != 250 || received.AvailableBytes != 750 || received.NodeVersion != "0.1.0" || received.Endpoint != "https://192.168.1.42:9443" || received.Timestamp != now.Unix() {
		t.Fatalf("unexpected heartbeat: %#v", received)
	}
}

func TestWebRTCHeartbeatDoesNotAdvertiseEndpoint(t *testing.T) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	var received Payload
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		var body struct {
			Heartbeat string `json:"heartbeat"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		received, err = Verify(body.Heartbeat, privateKey.Public().(ed25519.PublicKey))
		if err != nil {
			t.Fatal(err)
		}
		return &http.Response{StatusCode: http.StatusNoContent, Body: io.NopCloser(bytes.NewReader(nil)), Header: make(http.Header)}, nil
	})}
	reporter := Reporter{ControlPlaneURL: "https://control.example", NodeID: "node-a", NodeVersion: "0.1.0", Transport: "webrtc", Stats: testStats{storage.Stats{CapacityBytes: 1000}}, Signer: testSigner{privateKey}, Client: client}
	if err := reporter.Report(context.Background()); err != nil {
		t.Fatal(err)
	}
	if received.Transport != "webrtc" || received.Endpoint != "" {
		t.Fatalf("unexpected WebRTC heartbeat: %#v", received)
	}
}

func TestReporterAcknowledgesCompletedDeletionOnNextHeartbeat(t *testing.T) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil { t.Fatal(err) }
	requests := 0
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		requests++
		var body struct { Heartbeat string `json:"heartbeat"` }
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil { t.Fatal(err) }
		payloadBytes, err := base64.RawURLEncoding.DecodeString(strings.Split(body.Heartbeat, ".")[0])
		if err != nil { t.Fatal(err) }
		var payload Payload
		if err := json.Unmarshal(payloadBytes, &payload); err != nil { t.Fatal(err) }
		if requests == 1 {
			return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{"deleteTasks":[{"taskId":"00000000-0000-4000-8000-000000000001","objectId":"file/object","capability":"cap"}]}`)), Header: make(http.Header)}, nil
		}
		if len(payload.DeletionResults) != 1 || payload.DeletionResults[0].TaskID != "00000000-0000-4000-8000-000000000001" || payload.DeletionResults[0].Status != "deleted" { t.Fatalf("missing deletion acknowledgement: %#v", payload.DeletionResults) }
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{}`)), Header: make(http.Header)}, nil
	})}
	reporter := Reporter{ControlPlaneURL: "https://control.example", NodeID: "node-a", NodeVersion: "0.1.0", Endpoint: "https://192.168.1.42:9443", Stats: testStats{storage.Stats{}}, Signer: testSigner{privateKey}, Client: client, Delete: func(_ context.Context, task DeletionTask) error { if task.ObjectID != "file/object" || task.Capability != "cap" { t.Fatalf("unexpected task: %#v", task) }; return nil }}
	if err := reporter.Report(context.Background()); err != nil { t.Fatal(err) }
	if err := reporter.Report(context.Background()); err != nil { t.Fatal(err) }
}

func TestReporterBatchesDeletionFailuresWithinHeartbeatLimit(t *testing.T) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	var received []Payload
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Fatal(err)
		}
		if len(body) > 4096 {
			t.Fatalf("heartbeat exceeded Worker bound: %d", len(body))
		}
		var envelope struct {
			Heartbeat string `json:"heartbeat"`
		}
		if err := json.Unmarshal(body, &envelope); err != nil {
			t.Fatal(err)
		}
		payloadBytes, err := base64.RawURLEncoding.DecodeString(strings.Split(envelope.Heartbeat, ".")[0])
		if err != nil {
			t.Fatal(err)
		}
		var payload Payload
		if err := json.Unmarshal(payloadBytes, &payload); err != nil {
			t.Fatal(err)
		}
		received = append(received, payload)
		return &http.Response{StatusCode: http.StatusNoContent, Body: io.NopCloser(strings.NewReader("")), Header: make(http.Header)}, nil
	})}
	reporter := Reporter{ControlPlaneURL: "https://control.example", NodeID: "node-a", NodeVersion: "0.1.0", Endpoint: "https://192.168.1.42:9443", Stats: testStats{storage.Stats{CapacityBytes: 100, UsedBytes: 10, AvailableBytes: 90}}, Signer: testSigner{privateKey}, Client: client}
	for index := 0; index < 16; index++ {
		reporter.pendingResults = append(reporter.pendingResults, DeletionResult{TaskID: fmt.Sprintf("00000000-0000-4000-8000-%012d", index), ObjectID: fmt.Sprintf("file/shard/%03d", index), Status: "failed", Error: strings.Repeat("disk delete failed: permission denied; retry later ", 5)})
	}
	if err := reporter.Report(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(received) != 1 || len(received[0].DeletionResults) == 0 || len(received[0].DeletionResults) >= 16 {
		t.Fatalf("expected a bounded prefix, got %#v", received)
	}
	if received[0].AvailableBytes != 90 {
		t.Fatalf("ordinary heartbeat health was lost: %#v", received[0])
	}
	if len(reporter.pendingResults) != 16-len(received[0].DeletionResults) {
		t.Fatalf("wrong pending queue length: %d", len(reporter.pendingResults))
	}
	if err := reporter.Report(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(received) != 2 || received[1].DeletionResults[0].TaskID == received[0].DeletionResults[0].TaskID {
		t.Fatalf("remaining results were not sent incrementally: %#v", received)
	}
}

func TestReporterRetainsResultsAfterRejectedHeartbeatAndTruncatesErrors(t *testing.T) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	attempts := 0
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		attempts++
		var envelope struct {
			Heartbeat string `json:"heartbeat"`
		}
		if err := json.NewDecoder(request.Body).Decode(&envelope); err != nil {
			t.Fatal(err)
		}
		payloadBytes, err := base64.RawURLEncoding.DecodeString(strings.Split(envelope.Heartbeat, ".")[0])
		if err != nil {
			t.Fatal(err)
		}
		var payload Payload
		if err := json.Unmarshal(payloadBytes, &payload); err != nil {
			t.Fatal(err)
		}
		if len(payload.DeletionResults) != 1 || len(payload.DeletionResults[0].Error) > 256 {
			t.Fatalf("oversized error poisoned heartbeat: %#v", payload.DeletionResults)
		}
		status := http.StatusServiceUnavailable
		if attempts > 1 {
			status = http.StatusNoContent
		}
		return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader("")), Header: make(http.Header)}, nil
	})}
	reporter := Reporter{ControlPlaneURL: "https://control.example", NodeID: "node-a", NodeVersion: "0.1.0", Endpoint: "https://192.168.1.42:9443", Stats: testStats{}, Signer: testSigner{privateKey}, Client: client, pendingResults: []DeletionResult{{TaskID: "00000000-0000-4000-8000-000000000001", ObjectID: "file/object", Status: "failed", Error: strings.Repeat("x", 10_000)}}}
	if err := reporter.Report(context.Background()); err == nil {
		t.Fatal("expected transient rejection")
	}
	if len(reporter.pendingResults) != 1 {
		t.Fatal("rejected heartbeat lost result")
	}
	if err := reporter.Report(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(reporter.pendingResults) != 0 {
		t.Fatal("acknowledged result remained pending")
	}
}
