package enrollment

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"testing"
)

type testIdentity struct {
	publicKey  ed25519.PublicKey
	privateKey ed25519.PrivateKey
}

func (identity testIdentity) PublicKeyBase64() string {
	return base64.RawURLEncoding.EncodeToString(identity.publicKey)
}

func (identity testIdentity) Sign(payload []byte) []byte {
	return ed25519.Sign(identity.privateKey, payload)
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

func TestEnrollProvesIdentityPossession(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	identity := testIdentity{publicKey: publicKey, privateKey: privateKey}
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path != "/nodes/enroll" {
			t.Fatalf("wrong enrollment path: %s", request.URL.Path)
		}
		var body struct {
			ChallengeID   string `json:"challengeId"`
			Token         string `json:"token"`
			PublicKey     string `json:"publicKey"`
			Signature     string `json:"signature"`
			Name          string `json:"name"`
			CapacityBytes int64  `json:"capacityBytes"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		signature, err := base64.RawURLEncoding.DecodeString(body.Signature)
		if err != nil {
			t.Fatal(err)
		}
		proof := []byte("horcrux-enroll-v1:" + body.ChallengeID + ":" + body.Token + ":" + body.PublicKey)
		if !ed25519.Verify(publicKey, proof, signature) {
			t.Fatal("enrollment signature did not verify")
		}
		if body.ChallengeID != "challenge-id" || body.Token != "one-time-token" || body.Name != "Aaron's laptop" || body.CapacityBytes != 1_000 {
			t.Fatalf("unexpected enrollment body: %#v", body)
		}
		response, _ := json.Marshal(Response{NodeID: "node_test", PublicKey: body.PublicKey, Status: "offline"})
		return &http.Response{StatusCode: http.StatusCreated, Body: io.NopCloser(bytes.NewReader(response)), Header: make(http.Header)}, nil
	})}

	response, err := Enroll(context.Background(), Request{
		Transport:       "webrtc",
		ControlPlaneURL: "https://control.example/",
		ChallengeID:     "challenge-id",
		Token:           "one-time-token",
		Name:            "Aaron's laptop",
		CapacityBytes:   1_000,
		Identity:        identity,
		Client:          client,
	})
	if err != nil {
		t.Fatal(err)
	}
	if response.NodeID != "node_test" {
		t.Fatalf("unexpected enrollment response: %#v", response)
	}
}
