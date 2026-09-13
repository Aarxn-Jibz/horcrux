package heartbeat

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"io"
	"net/http"
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
