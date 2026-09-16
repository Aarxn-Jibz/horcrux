package heartbeat

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/horcrux-file-system/horcrux/apps/node/internal/receipt"
	"github.com/horcrux-file-system/horcrux/apps/node/internal/storage"
)

const ProtocolVersion = "1"
const maxHeartbeatBodyBytes = 4096
const maxDeletionErrorRunes = 120

var ErrInvalidHeartbeat = errors.New("invalid node heartbeat")

type Payload struct {
	Version         string           `json:"version"`
	NodeID          string           `json:"nodeId"`
	Status          string           `json:"status"`
	CapacityBytes   int64            `json:"capacityBytes"`
	UsedBytes       int64            `json:"usedBytes"`
	AvailableBytes  int64            `json:"availableBytes"`
	NodeVersion     string           `json:"nodeVersion"`
	Endpoint        string           `json:"endpoint"`
	Timestamp       int64            `json:"timestamp"`
	Features        []string         `json:"features,omitempty"`
	DeletionResults []DeletionResult `json:"deletionResults,omitempty"`
}

type DeletionResult struct {
	TaskID   string `json:"taskId"`
	ObjectID string `json:"objectId"`
	Status   string `json:"status"`
	Error    string `json:"error,omitempty"`
}

type DeletionTask struct {
	TaskID     string `json:"taskId"`
	ObjectID   string `json:"objectId"`
	Capability string `json:"capability"`
}

type deletionResponse struct {
	DeleteTasks []DeletionTask `json:"deleteTasks"`
}

type StatsProvider interface {
	Stats(context.Context) (storage.Stats, error)
}

type Reporter struct {
	ControlPlaneURL string
	NodeID          string
	NodeVersion     string
	Endpoint        string
	Interval        time.Duration
	Stats           StatsProvider
	Signer          receipt.PayloadSigner
	Client          *http.Client
	OnError         func(error)
	Now             func() time.Time
	Delete          func(context.Context, DeletionTask) error
	pendingResults  []DeletionResult
	resultsMu       sync.Mutex
}

func (reporter *Reporter) Run(ctx context.Context) {
	interval := reporter.Interval
	if interval <= 0 {
		interval = 30 * time.Second
	}
	reporter.reportError(reporter.Report(ctx))
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			reporter.reportError(reporter.Report(ctx))
		}
	}
}

func (reporter *Reporter) Report(ctx context.Context) error {
	stats, err := reporter.Stats.Stats(ctx)
	if err != nil {
		return fmt.Errorf("read heartbeat stats: %w", err)
	}
	now := time.Now().UTC()
	if reporter.Now != nil {
		now = reporter.Now().UTC()
	}
	reporter.resultsMu.Lock()
	results := make([]DeletionResult, len(reporter.pendingResults))
	for index, pending := range reporter.pendingResults {
		results[index] = pending
		results[index].Error = boundedDeletionError(pending.Error)
	}
	reporter.resultsMu.Unlock()
	payload := Payload{Version: ProtocolVersion, NodeID: reporter.NodeID, Status: "online", CapacityBytes: stats.CapacityBytes, UsedBytes: stats.UsedBytes, AvailableBytes: stats.AvailableBytes, NodeVersion: reporter.NodeVersion, Endpoint: reporter.Endpoint, Timestamp: now.Unix(), Features: []string{"deletion-tasks-v1"}}
	var body []byte
	for {
		payload.DeletionResults = results
		token, signErr := Sign(payload, reporter.Signer)
		if signErr != nil {
			return signErr
		}
		body, err = json.Marshal(map[string]string{"heartbeat": token})
		if err != nil {
			return err
		}
		if len(body) <= maxHeartbeatBodyBytes || len(results) == 0 {
			break
		}
		results = results[:len(results)-1]
	}
	endpoint := strings.TrimRight(reporter.ControlPlaneURL, "/") + "/nodes/" + url.PathEscape(reporter.NodeID) + "/heartbeat"
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	client := reporter.Client
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("send heartbeat: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("heartbeat rejected with status %d", response.StatusCode)
	}
	if len(results) > 0 {
		reporter.resultsMu.Lock()
		if len(reporter.pendingResults) >= len(results) {
			reporter.pendingResults = reporter.pendingResults[len(results):]
		}
		reporter.resultsMu.Unlock()
	}
	if response.StatusCode == http.StatusNoContent {
		return nil
	}
	var reply deletionResponse
	if err := json.NewDecoder(response.Body).Decode(&reply); err != nil {
		return fmt.Errorf("decode heartbeat response: %w", err)
	}
	for _, task := range reply.DeleteTasks {
		if reporter.Delete == nil {
			break
		}
		result := DeletionResult{TaskID: task.TaskID, ObjectID: task.ObjectID, Status: "deleted"}
		if err := reporter.Delete(ctx, task); err != nil {
			result.Status, result.Error = "failed", err.Error()
		}
		reporter.resultsMu.Lock()
		reporter.pendingResults = append(reporter.pendingResults, result)
		reporter.resultsMu.Unlock()
	}
	return nil
}

func boundedDeletionError(value string) string {
	runes := []rune(value)
	if len(runes) <= maxDeletionErrorRunes {
		return value
	}
	return string(runes[:maxDeletionErrorRunes-3]) + "..."
}

func Sign(payload Payload, signer receipt.PayloadSigner) (string, error) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	signature := signer.Sign(encoded)
	return base64.RawURLEncoding.EncodeToString(encoded) + "." + base64.RawURLEncoding.EncodeToString(signature), nil
}

func Verify(token string, publicKey ed25519.PublicKey) (Payload, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return Payload{}, ErrInvalidHeartbeat
	}
	payloadBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return Payload{}, ErrInvalidHeartbeat
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || !ed25519.Verify(publicKey, payloadBytes, signature) {
		return Payload{}, ErrInvalidHeartbeat
	}
	decoder := json.NewDecoder(bytes.NewReader(payloadBytes))
	decoder.DisallowUnknownFields()
	var payload Payload
	if err := decoder.Decode(&payload); err != nil || payload.Version != ProtocolVersion || payload.NodeID == "" || payload.Status != "online" || payload.CapacityBytes < 0 || payload.UsedBytes < 0 || payload.AvailableBytes < 0 || payload.NodeVersion == "" || payload.Endpoint == "" {
		return Payload{}, ErrInvalidHeartbeat
	}
	return payload, nil
}

func (reporter *Reporter) reportError(err error) {
	if err != nil && reporter.OnError != nil {
		reporter.OnError(err)
	}
}
