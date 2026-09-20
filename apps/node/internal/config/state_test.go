package config

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func testControlPlaneKey() string {
	return base64.RawURLEncoding.EncodeToString(make([]byte, ed25519.PublicKeySize))
}

func TestJoinTokenAndSavedConfiguration(t *testing.T) {
	encoded, err := json.Marshal(JoinToken{ChallengeID: "challenge", Token: "one-time-token", ControlPlaneURL: "https://control.example", ControlPlanePublicKey: testControlPlaneKey()})
	if err != nil {
		t.Fatal(err)
	}
	config, token, directory, err := ParseJoin([]string{base64.RawURLEncoding.EncodeToString(encoded), "--config-dir", t.TempDir(), "--storage-dir", t.TempDir(), "--listen", "127.0.0.1:9444"})
	if err != nil {
		t.Fatal(err)
	}
	if token.Token != "one-time-token" || config.Transport != "webrtc" || config.ListenAddress != "127.0.0.1:9444" {
		t.Fatalf("unexpected join configuration: %#v", config)
	}
	if err := Save(directory, config); err != nil {
		t.Fatal(err)
	}
	loaded, err := Load(directory)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.ControlPlaneURL != config.ControlPlaneURL || loaded.DataDirectory != config.DataDirectory {
		t.Fatalf("saved configuration changed: %#v", loaded)
	}
}

func TestRejectsJoinTokenWithInvalidControlPlaneKey(t *testing.T) {
	encoded, err := json.Marshal(JoinToken{ChallengeID: "challenge", Token: "one-time-token", ControlPlaneURL: "https://control.example", ControlPlanePublicKey: "not-a-public-key"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DecodeJoinToken(base64.RawURLEncoding.EncodeToString(encoded)); err == nil {
		t.Fatal("join token with an invalid control-plane key was accepted")
	}
}

func TestRejectsMalformedSavedConfiguration(t *testing.T) {
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, stateFilename), []byte("not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(directory); err == nil {
		t.Fatal("corrupt configuration was accepted")
	}
}
