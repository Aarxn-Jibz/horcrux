package webrtc

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/horcrux-file-system/horcrux/apps/node/internal/receipt"
)

type NodeAuth struct {
	Version   string `json:"version"`
	NodeID    string `json:"nodeId"`
	Timestamp int64  `json:"timestamp"`
}
type Signal struct {
	Type    string `json:"type"`
	Payload string `json:"payload"`
}
type SignalingClient struct {
	ControlPlaneURL, NodeID string
	Signer                  receipt.PayloadSigner
	Client                  *http.Client
}

func (client *SignalingClient) Exchange(ctx context.Context, sessionID string, signal *Signal) ([]Signal, error) {
	auth, err := client.auth()
	if err != nil {
		return nil, err
	}
	body, err := json.Marshal(struct {
		Auth      string  `json:"auth"`
		SessionID string  `json:"sessionId"`
		Signal    *Signal `json:"signal,omitempty"`
	}{auth, sessionID, signal})
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(client.ControlPlaneURL, "/")+"/nodes/"+client.NodeID+"/webrtc/signals", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	httpClient := client.Client
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 10 * time.Second}
	}
	response, err := httpClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode/100 != 2 {
		return nil, fmt.Errorf("signal exchange rejected: %d", response.StatusCode)
	}
	var decoded struct {
		Signals []Signal `json:"signals"`
	}
	if err := json.NewDecoder(response.Body).Decode(&decoded); err != nil {
		return nil, err
	}
	return decoded.Signals, nil
}

func (client *SignalingClient) Sessions(ctx context.Context) ([]string, error) {
	auth, err := client.auth()
	if err != nil {
		return nil, err
	}
	body, _ := json.Marshal(map[string]string{"auth": auth})
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(client.ControlPlaneURL, "/")+"/nodes/"+client.NodeID+"/webrtc/sessions", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	httpClient := client.Client
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 10 * time.Second}
	}
	response, err := httpClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode/100 != 2 {
		return nil, fmt.Errorf("session discovery rejected: %d", response.StatusCode)
	}
	var decoded struct {
		Sessions []string `json:"sessions"`
	}
	err = json.NewDecoder(response.Body).Decode(&decoded)
	return decoded.Sessions, err
}
func (client *SignalingClient) auth() (string, error) {
	payload, err := json.Marshal(NodeAuth{Version: "1", NodeID: client.NodeID, Timestamp: time.Now().Unix()})
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(payload) + "." + base64.RawURLEncoding.EncodeToString(client.Signer.Sign(payload)), nil
}
