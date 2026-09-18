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
	"time"
)

func checksum(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

func openTestStore(t *testing.T, capacity int64) *Store {
	t.Helper()
	return openStore(t, t.TempDir(), capacity)
}

func openStore(t *testing.T, root string, capacity int64) *Store {
	t.Helper()
	store, err := Open(root, capacity)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

func TestPutAndDeleteSurviveRestart(t *testing.T) {
	root := t.TempDir()
	data := []byte("survives a node restart")
	store := openStore(t, root, 1024)
	metadata, err := store.Put(context.Background(), "restart/object", bytes.NewReader(data), checksum(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	store = openStore(t, root, 1024)
	reader, _, err := store.OpenObject(context.Background(), metadata.ObjectID)
	if err != nil {
		t.Fatal(err)
	}
	restored, err := io.ReadAll(reader)
	if closeErr := reader.Close(); err != nil || closeErr != nil || !bytes.Equal(restored, data) {
		t.Fatalf("restart read mismatch: %q, %v, %v", restored, err, closeErr)
	}
	if err := store.Delete(context.Background(), metadata.ObjectID); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	store = openStore(t, root, 1024)
	if _, err := store.Metadata(context.Background(), metadata.ObjectID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted object reappeared after restart: %v", err)
	}
}

func TestRestartCleansUncommittedFilesAndAllowsRetry(t *testing.T) {
	root := t.TempDir()
	store := openStore(t, root, 1024)
	objectID := "retry/object"
	path := store.objectPath(objectID)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("orphaned before metadata"), 0o600); err != nil {
		t.Fatal(err)
	}
	pending := filepath.Join(filepath.Dir(path), ".pending-interrupted")
	if err := os.WriteFile(pending, []byte("partial"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	store = openStore(t, root, 1024)
	for _, candidate := range []string{path, pending} {
		if _, err := os.Stat(candidate); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("uncommitted file survived restart: %s: %v", candidate, err)
		}
	}
	data := []byte("retry succeeds")
	if _, err := store.Put(context.Background(), objectID, bytes.NewReader(data), checksum(data), int64(len(data))); err != nil {
		t.Fatalf("retry after cleanup: %v", err)
	}
}

func TestDeleteWaitsForOpenObject(t *testing.T) {
	store := openTestStore(t, 1024)
	data := []byte("close before delete")
	if _, err := store.Put(context.Background(), "open/object", bytes.NewReader(data), checksum(data), int64(len(data))); err != nil {
		t.Fatal(err)
	}
	reader, _, err := store.OpenObject(context.Background(), "open/object")
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	deleted := make(chan error, 1)
	go func() {
		close(started)
		deleted <- store.Delete(context.Background(), "open/object")
	}()
	<-started
	select {
	case err := <-deleted:
		t.Fatalf("delete completed while object was open: %v", err)
	case <-time.After(25 * time.Millisecond):
	}
	if err := reader.Close(); err != nil {
		t.Fatal(err)
	}
	if err := <-deleted; err != nil {
		t.Fatal(err)
	}
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
