package webrtc

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"testing"
	"time"

	"github.com/horcrux-file-system/horcrux/apps/node/internal/authorization"
	"github.com/horcrux-file-system/horcrux/apps/node/internal/receipt"
	"github.com/horcrux-file-system/horcrux/apps/node/internal/storage"
)

type operationSigner struct{ key ed25519.PrivateKey }

func (s operationSigner) Sign(payload []byte) []byte { return ed25519.Sign(s.key, payload) }

func operationSession(t *testing.T, ctx context.Context, capacity int64, objectID string, data []byte) (*ObjectSession, Control, ed25519.PublicKey) {
	t.Helper()
	controlPublic, controlPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	receiptPublic, receiptPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	store, err := storage.Open(t.TempDir(), capacity)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	now := time.Unix(2_000_000_000, 0)
	size := int64(len(data))
	digest := sha256.Sum256(data)
	capability := authorization.Capability{Version: authorization.ProtocolVersion, Issuer: "horcrux-control-plane", NodeID: "node-a", ObjectID: objectID, Operation: "PUT", IssuedAt: now.Unix(), ExpiresAt: now.Add(time.Minute).Unix(), JTI: "request-1234567890", Checksum: hex.EncodeToString(digest[:]), Size: &size}
	token, err := authorization.Sign(capability, controlPrivate)
	if err != nil {
		t.Fatal(err)
	}
	return NewObjectSession(ctx, "node-a", store, authorization.Verifier{PublicKey: controlPublic, NodeID: "node-a", Issuer: "horcrux-control-plane", Now: func() time.Time { return now }}, operationSigner{receiptPrivate}), Control{Type: "put-init", Capability: token, ObjectID: objectID}, receiptPublic
}

func writeSoon(session *ObjectSession, data []byte) <-chan error {
	done := make(chan error, 1)
	go func() { done <- session.Write(data) }()
	return done
}
func expectSoon(t *testing.T, done <-chan error) error {
	t.Helper()
	select {
	case err := <-done:
		return err
	case <-time.After(time.Second):
		t.Fatal("operation blocked")
		return nil
	}
}

func TestObjectSessionReturnsEarlyStorageFailuresToWriter(t *testing.T) {
	data := []byte("opaque")
	for _, capacity := range []int64{1} {
		t.Run("capacity", func(t *testing.T) {
			session, control, _ := operationSession(t, context.Background(), capacity, "file/shard/object", data)
			if err := session.Begin(control); err != nil {
				t.Fatal(err)
			}
			if err := expectSoon(t, writeSoon(session, data)); !errors.Is(err, storage.ErrCapacity) {
				t.Fatalf("capacity failure did not reach writer: %v", err)
			}
			session.Abort()
		})
	}
	t.Run("existing object", func(t *testing.T) {
		session, control, _ := operationSession(t, context.Background(), 1024, "file/shard/object", data)
		other := []byte("different")
		digest := sha256.Sum256(other)
		if _, err := session.store.Put(context.Background(), control.ObjectID, bytes.NewReader(other), hex.EncodeToString(digest[:]), int64(len(other))); err != nil {
			t.Fatal(err)
		}
		if err := session.Begin(control); err != nil {
			t.Fatal(err)
		}
		if err := expectSoon(t, writeSoon(session, data)); !errors.Is(err, storage.ErrConflict) {
			t.Fatalf("existing-object failure did not reach writer: %v", err)
		}
		session.Abort()
	})
}

func TestObjectSessionAbortUnblocksBlockedWrite(t *testing.T) {
	reader, writer := io.Pipe()
	defer reader.Close()
	maximum := int64(1)
	session := &ObjectSession{pipe: writer, capability: authorization.Capability{MaxSize: &maximum}}
	write := writeSoon(session, []byte("x"))
	time.Sleep(20 * time.Millisecond)
	aborted := make(chan struct{})
	go func() { session.Abort(); close(aborted) }()
	select {
	case <-aborted:
	case <-time.After(time.Second):
		t.Fatal("abort blocked on writer mutex")
	}
	if err := expectSoon(t, write); err == nil {
		t.Fatal("blocked write unexpectedly succeeded")
	}
}

func TestObjectSessionCancellationAndSuccessfulReceipt(t *testing.T) {
	data := []byte("opaque")
	ctx, cancel := context.WithCancel(context.Background())
	session, control, _ := operationSession(t, ctx, 1024, "file/shard/cancel", data)
	if err := session.Begin(control); err != nil {
		t.Fatal(err)
	}
	cancel()
	if err := expectSoon(t, writeSoon(session, data)); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled session did not reach writer: %v", err)
	}

	session, control, publicKey := operationSession(t, context.Background(), 1024, "file/shard/success", data)
	if err := session.Begin(control); err != nil {
		t.Fatal(err)
	}
	if err := expectSoon(t, writeSoon(session, data)); err != nil {
		t.Fatal(err)
	}
	response, err := session.Finish()
	if err != nil {
		t.Fatal(err)
	}
	verified, err := receipt.Verify(response.Capability, publicKey)
	if err != nil || verified.ObjectID != control.ObjectID || verified.Size != int64(len(data)) {
		t.Fatalf("unexpected receipt %#v: %v", verified, err)
	}
}

func TestObjectSessionRepeatedFailuresAndAbortsDoNotBlock(t *testing.T) {
	for index := 0; index < 20; index++ {
		session, control, _ := operationSession(t, context.Background(), 1, "file/shard/object", []byte("xx"))
		if err := session.Begin(control); err != nil {
			t.Fatal(err)
		}
		if err := expectSoon(t, writeSoon(session, []byte("xx"))); err == nil {
			t.Fatal("expected storage failure")
		}
		session.Abort()
	}
}
