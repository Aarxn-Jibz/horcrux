package webrtc

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

type signalingSigner struct{ key ed25519.PrivateKey }

func (s signalingSigner) Sign(payload []byte) []byte { return ed25519.Sign(s.key, payload) }

func TestSignalingAuthBindsOperationSessionAndSignal(t *testing.T) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	client := SignalingClient{NodeID: "node-a", Signer: signalingSigner{privateKey}}
	token, err := client.auth("signals", "00000000-0000-4000-8000-000000000001", &Signal{Type: "answer", Payload: "sdp-a"})
	if err != nil {
		t.Fatal(err)
	}
	payload, err := base64.RawURLEncoding.DecodeString(strings.Split(token, ".")[0])
	if err != nil {
		t.Fatal(err)
	}
	var auth NodeAuth
	if err := json.Unmarshal(payload, &auth); err != nil {
		t.Fatal(err)
	}
	if auth.Operation != "signals" || auth.SessionID != "00000000-0000-4000-8000-000000000001" || auth.SignalType != "answer" || auth.SignalHash == "" {
		t.Fatalf("auth did not bind request: %#v", auth)
	}
	sessions, err := client.auth("sessions", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	payload, err = base64.RawURLEncoding.DecodeString(strings.Split(sessions, ".")[0])
	if err != nil {
		t.Fatal(err)
	}
	auth = NodeAuth{}
	if err := json.Unmarshal(payload, &auth); err != nil {
		t.Fatal(err)
	}
	if auth.Operation != "sessions" || auth.SessionID != "" || auth.SignalHash != "" {
		t.Fatalf("session discovery auth has extra scope: %#v", auth)
	}
}
