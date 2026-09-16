package storage

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func checksum(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

func openTestStore(t *testing.T, capacity int64) *Store {
	t.Helper()
	store, err := Open(t.TempDir(), capacity)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

func TestPutReadDeleteAndCapacity(t *testing.T) {
	store := openTestStore(t, 1024)
	data := []byte("opaque encrypted object")
	metadata, err := store.Put(context.Background(), "file-id/shard/object-id", bytes.NewReader(data), checksum(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	if metadata.Size != int64(len(data)) || metadata.Checksum != checksum(data) {
		t.Fatalf("unexpected metadata: %#v", metadata)
	}
	reader, _, err := store.OpenObject(context.Background(), metadata.ObjectID)
	if err != nil {
		t.Fatal(err)
	}
	restored, err := io.ReadAll(reader)
	reader.Close()
	if err != nil || !bytes.Equal(restored, data) {
		t.Fatalf("read mismatch: %q, %v", restored, err)
	}
	stats, err := store.Stats(context.Background())
	if err != nil || stats.UsedBytes != int64(len(data)) || stats.AvailableBytes != 1024-int64(len(data)) {
		t.Fatalf("unexpected stats: %#v, %v", stats, err)
	}
	if err := store.Delete(context.Background(), metadata.ObjectID); err != nil {
		t.Fatal(err)
	}
	if err := store.Delete(context.Background(), metadata.ObjectID); err != nil {
		t.Fatalf("repeated delete must succeed: %v", err)
	}
	if _, _, err := store.OpenObject(context.Background(), metadata.ObjectID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected deleted object to be missing, got %v", err)
	}
}

func TestRejectsInvalidObjectIDs(t *testing.T) {
	invalid := []string{"", "../secret", "file/../../secret", "/absolute", "file//object", "file/./object", "white space"}
	for _, objectID := range invalid {
		if err := ValidateObjectID(objectID); !errors.Is(err, ErrInvalidObjectID) {
			t.Errorf("expected %q to be invalid, got %v", objectID, err)
		}
	}
}

func TestChecksumAndSizeMismatchLeaveNoPartialObject(t *testing.T) {
	store := openTestStore(t, 1024)
	data := []byte("opaque")
	if _, err := store.Put(context.Background(), "valid/object", bytes.NewReader(data), checksum([]byte("different")), int64(len(data))); !errors.Is(err, ErrChecksumMismatch) {
		t.Fatalf("expected checksum mismatch, got %v", err)
	}
	if _, err := store.Put(context.Background(), "valid/object", bytes.NewReader(data), checksum(data), int64(len(data)+1)); !errors.Is(err, ErrSizeMismatch) {
		t.Fatalf("expected size mismatch, got %v", err)
	}
	if _, err := store.Metadata(context.Background(), "valid/object"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("failed writes must not create metadata, got %v", err)
	}
	err := filepath.WalkDir(store.objectsRoot, func(path string, entry os.DirEntry, err error) error {
		if err == nil && !entry.IsDir() && len(entry.Name()) >= len(".pending-") && entry.Name()[:len(".pending-")] == ".pending-" {
			t.Errorf("temporary object leaked: %s", path)
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestCapacityAndIdempotency(t *testing.T) {
	store := openTestStore(t, 5)
	data := []byte("12345")
	first, err := store.Put(context.Background(), "object-a", bytes.NewReader(data), checksum(data), 5)
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.Put(context.Background(), "object-a", bytes.NewReader(data), checksum(data), 5)
	if err != nil || first.Path != second.Path {
		t.Fatalf("idempotent put failed: %#v, %v", second, err)
	}
	if _, err := store.Put(context.Background(), "object-b", bytes.NewReader([]byte("x")), checksum([]byte("x")), 1); !errors.Is(err, ErrCapacity) {
		t.Fatalf("expected capacity error, got %v", err)
	}
}
