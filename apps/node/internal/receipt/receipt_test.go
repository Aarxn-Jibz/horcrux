package receipt

import (
	"crypto/ed25519"
	"crypto/rand"
	"testing"
	"time"
)

type privateSigner struct{ key ed25519.PrivateKey }

func (signer privateSigner) Sign(payload []byte) []byte {
	return ed25519.Sign(signer.key, payload)
}

func TestSignedReceiptContents(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Unix(2_000_000_000, 0)
	checksum := "bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721"
	token, created, err := Create(privateSigner{privateKey}, "node-a", "file/shard/object", checksum, 6, "request-1234567890", now)
	if err != nil {
		t.Fatal(err)
	}
	verified, err := Verify(token, publicKey)
	if err != nil {
		t.Fatal(err)
	}
	if verified != created {
		t.Fatalf("verified receipt differs: %#v != %#v", verified, created)
	}
	if verified.NodeID != "node-a" || verified.ObjectID != "file/shard/object" || verified.Checksum != checksum || verified.Size != 6 || verified.Timestamp != now.Unix() || verified.RequestID != "request-1234567890" {
		t.Fatalf("receipt fields changed: %#v", verified)
	}
}

func TestRejectsTamperedReceipt(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	token, _, err := Create(privateSigner{privateKey}, "node-a", "object-a", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 1, "request-1234567890", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Verify(token+"x", publicKey); err == nil {
		t.Fatal("tampered receipt was accepted")
	}
}
