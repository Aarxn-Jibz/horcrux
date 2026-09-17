package enrollment

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

type NodeIdentity interface {
	PublicKeyBase64() string
	Sign([]byte) []byte
}

type Request struct {
	ControlPlaneURL string
	Transport       string
	ChallengeID     string
	Token           string
	Name            string
	CapacityBytes   int64
	Identity        NodeIdentity
	Client          *http.Client
}

type Response struct {
	NodeID    string `json:"nodeId"`
	PublicKey string `json:"publicKey"`
	Status    string `json:"status"`
}

func Enroll(ctx context.Context, request Request) (Response, error) {
	publicKey := request.Identity.PublicKeyBase64()
	proof := []byte("horcrux-enroll-v1:" + request.ChallengeID + ":" + request.Token + ":" + publicKey)
	body, err := json.Marshal(map[string]any{
		"challengeId":   request.ChallengeID,
		"token":         request.Token,
		"publicKey":     publicKey,
		"signature":     base64.RawURLEncoding.EncodeToString(request.Identity.Sign(proof)),
		"name":          request.Name,
		"capacityBytes": request.CapacityBytes,
		"transport":     request.Transport,
	})
	if err != nil {
		return Response{}, fmt.Errorf("encode enrollment request: %w", err)
	}

	httpRequest, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		strings.TrimRight(request.ControlPlaneURL, "/")+"/nodes/enroll",
		bytes.NewReader(body),
	)
	if err != nil {
		return Response{}, fmt.Errorf("create enrollment request: %w", err)
	}
	httpRequest.Header.Set("Content-Type", "application/json")
	client := request.Client
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	httpResponse, err := client.Do(httpRequest)
	if err != nil {
		return Response{}, fmt.Errorf("send enrollment request: %w", err)
	}
	defer httpResponse.Body.Close()
	if httpResponse.StatusCode != http.StatusCreated {
		return Response{}, fmt.Errorf("enrollment rejected with status %d", httpResponse.StatusCode)
	}
	var response Response
	if err := json.NewDecoder(httpResponse.Body).Decode(&response); err != nil {
		return Response{}, fmt.Errorf("decode enrollment response: %w", err)
	}
	if response.NodeID == "" || response.NodeID != strings.TrimSpace(response.NodeID) || response.PublicKey != publicKey {
		return Response{}, fmt.Errorf("enrollment response does not match this node identity")
	}
	return response, nil
}
