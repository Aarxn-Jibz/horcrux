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
	"time"

	"github.com/horcrux-file-system/horcrux/apps/node/internal/receipt"
	"github.com/horcrux-file-system/horcrux/apps/node/internal/storage"
)

const ProtocolVersion = "1"

var ErrInvalidHeartbeat = errors.New("invalid node heartbeat")

type Payload struct {
	Version        string `json:"version"`
	NodeID         string `json:"nodeId"`
	Status         string `json:"status"`
	CapacityBytes  int64  `json:"capacityBytes"`
	UsedBytes      int64  `json:"usedBytes"`
	AvailableBytes int64  `json:"availableBytes"`
	NodeVersion    string `json:"nodeVersion"`
	Endpoint       string `json:"endpoint"`
	Timestamp      int64  `json:"timestamp"`
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
	payload := Payload{Version: ProtocolVersion, NodeID: reporter.NodeID, Status: "online", CapacityBytes: stats.CapacityBytes, UsedBytes: stats.UsedBytes, AvailableBytes: stats.AvailableBytes, NodeVersion: reporter.NodeVersion, Endpoint: reporter.Endpoint, Timestamp: now.Unix()}
	token, err := Sign(payload, reporter.Signer)
	if err != nil {
		return err
	}
	body, err := json.Marshal(map[string]string{"heartbeat": token})
	if err != nil {
		return err
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
	return nil
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
