package identity

import (
	"crypto/ed25519"
	"os"
	"path/filepath"
	"testing"
)

func TestIdentityPersistsAndSigns(t *testing.T) {
	directory := t.TempDir()
	first, err := LoadOrCreate(directory)
	if err != nil {
		t.Fatal(err)
	}
	second, err := LoadOrCreate(directory)
	if err != nil {
		t.Fatal(err)
	}
	if first.NodeID != second.NodeID || first.PublicKeyBase64() != second.PublicKeyBase64() {
		t.Fatal("node identity changed after reload")
	}
	payload := []byte("receipt payload")
	if !ed25519.Verify(second.PublicKey, payload, first.Sign(payload)) {
		t.Fatal("identity signature did not verify")
	}
	info, err := os.Stat(filepath.Join(directory, identityFilename))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("private identity permissions are %o", info.Mode().Perm())
	}
}

func TestRejectsCorruptIdentity(t *testing.T) {
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, identityFilename), []byte(`{"nodeId":"wrong"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadOrCreate(directory); err == nil {
		t.Fatal("expected corrupt identity to fail")
	}
}
