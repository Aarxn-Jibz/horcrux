package authorization

import (
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"testing"
	"time"
)

func testVerifier(t *testing.T) (Verifier, ed25519.PrivateKey, time.Time) {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Unix(2_000_000_000, 0)
	return Verifier{PublicKey: publicKey, NodeID: "node-a", Issuer: "horcrux-control-plane", Now: func() time.Time { return now }}, privateKey, now
}

func validCapability(now time.Time) Capability {
	size := int64(6)
	return Capability{Version: ProtocolVersion, Issuer: "horcrux-control-plane", NodeID: "node-a", ObjectID: "file/shard/object", Operation: "PUT", IssuedAt: now.Unix(), ExpiresAt: now.Add(time.Minute).Unix(), JTI: "request-1234567890", Checksum: "bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721", Size: &size}
}

func signed(t *testing.T, capability Capability, privateKey ed25519.PrivateKey) string {
	t.Helper()
	token, err := Sign(capability, privateKey)
	if err != nil {
		t.Fatal(err)
	}
	return token
}

func TestAcceptsScopedCapability(t *testing.T) {
	verifier, privateKey, now := testVerifier(t)
	capability := validCapability(now)
	verified, err := verifier.Verify(signed(t, capability, privateKey), "PUT", capability.ObjectID)
	if err != nil || verified.JTI != capability.JTI {
		t.Fatalf("valid capability rejected: %#v, %v", verified, err)
	}
}

func TestRejectsExpiredCapability(t *testing.T) {
	verifier, privateKey, now := testVerifier(t)
	capability := validCapability(now)
	capability.ExpiresAt = now.Add(-time.Second).Unix()
	if _, err := verifier.Verify(signed(t, capability, privateKey), "PUT", capability.ObjectID); !errors.Is(err, ErrExpiredCapability) {
		t.Fatalf("expected expiration rejection, got %v", err)
	}
}

func TestRejectsWrongNodeObjectAndOperation(t *testing.T) {
	verifier, privateKey, now := testVerifier(t)
	capability := validCapability(now)
	token := signed(t, capability, privateKey)
	tests := []struct {
		name      string
		verifier  Verifier
		operation string
		objectID  string
		expected  error
	}{
		{"node", Verifier{PublicKey: verifier.PublicKey, NodeID: "node-b", Issuer: verifier.Issuer, Now: verifier.Now}, "PUT", capability.ObjectID, ErrWrongNode},
		{"object", verifier, "PUT", "unrelated/object", ErrWrongObject},
		{"operation", verifier, "DELETE", capability.ObjectID, ErrWrongOperation},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := test.verifier.Verify(token, test.operation, test.objectID); !errors.Is(err, test.expected) {
				t.Fatalf("expected %v, got %v", test.expected, err)
			}
		})
	}
}

func TestRejectsTamperedSignature(t *testing.T) {
	verifier, privateKey, now := testVerifier(t)
	token := signed(t, validCapability(now), privateKey)
	token = token[:len(token)-1] + "A"
	if _, err := verifier.Verify(token, "PUT", "file/shard/object"); !errors.Is(err, ErrInvalidCapability) {
		t.Fatalf("expected signature rejection, got %v", err)
	}
}
