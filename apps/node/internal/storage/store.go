package storage

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

var (
	ErrInvalidObjectID  = errors.New("invalid object ID")
	ErrChecksumMismatch = errors.New("object checksum mismatch")
	ErrSizeMismatch     = errors.New("object size mismatch")
	ErrNotFound         = errors.New("object not found")
	ErrConflict         = errors.New("object already exists with different metadata")
	ErrCapacity         = errors.New("node storage capacity exceeded")
)

var (
	objectIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/-]*$`)
	checksumPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
)

type Metadata struct {
	ObjectID  string
	Checksum  string
	Size      int64
	CreatedAt time.Time
	Status    string
	Path      string
}

type Stats struct {
	CapacityBytes  int64
	UsedBytes      int64
	AvailableBytes int64
}

type Store struct {
	root        string
	objectsRoot string
	database    *sql.DB
	capacity    int64
	mu          sync.Mutex
	reserved    int64
	pending     map[string]struct{}
}

func Open(root string, capacityBytes int64) (*Store, error) {
	if root == "" || capacityBytes < 1 {
		return nil, errors.New("storage root and positive capacity are required")
	}
	objectsRoot := filepath.Join(root, "objects")
	if err := os.MkdirAll(objectsRoot, 0o700); err != nil {
		return nil, fmt.Errorf("create object directory: %w", err)
	}
	database, err := sql.Open("sqlite3", filepath.Join(root, "metadata.sqlite")+"?_foreign_keys=on&_busy_timeout=5000&_journal_mode=WAL")
	if err != nil {
		return nil, fmt.Errorf("open metadata database: %w", err)
	}
	database.SetMaxOpenConns(1)
	if _, err := database.Exec(`CREATE TABLE IF NOT EXISTS objects (
		object_id TEXT PRIMARY KEY,
		checksum TEXT NOT NULL,
		size INTEGER NOT NULL CHECK(size >= 0),
		created_at INTEGER NOT NULL,
		status TEXT NOT NULL CHECK(status IN ('stored','deleted')),
		path TEXT NOT NULL
	)`); err != nil {
		database.Close()
		return nil, fmt.Errorf("initialize metadata database: %w", err)
	}
	return &Store{root: root, objectsRoot: objectsRoot, database: database, capacity: capacityBytes, pending: make(map[string]struct{})}, nil
}

func (s *Store) Close() error {
	return s.database.Close()
}

func ValidateObjectID(objectID string) error {
	if len(objectID) == 0 || len(objectID) > 256 || !objectIDPattern.MatchString(objectID) {
		return ErrInvalidObjectID
	}
	for _, segment := range strings.Split(objectID, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return ErrInvalidObjectID
		}
	}
	return nil
}

func (s *Store) Put(ctx context.Context, objectID string, source io.Reader, expectedChecksum string, expectedSize int64) (Metadata, error) {
	if err := ValidateObjectID(objectID); err != nil {
		return Metadata{}, err
	}
	if !checksumPattern.MatchString(expectedChecksum) {
		return Metadata{}, ErrChecksumMismatch
	}
	if expectedSize < 0 {
		return Metadata{}, ErrSizeMismatch
	}
	if existing, found, err := s.reserve(ctx, objectID, expectedChecksum, expectedSize); err != nil {
		return Metadata{}, err
	} else if found {
		return existing, nil
	}
	defer s.release(objectID, expectedSize)

	path := s.objectPath(objectID)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return Metadata{}, fmt.Errorf("create object prefix: %w", err)
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".pending-*")
	if err != nil {
		return Metadata{}, fmt.Errorf("create temporary object: %w", err)
	}
	temporaryPath := temporary.Name()
	committed := false
	defer func() {
		temporary.Close()
		if !committed {
			_ = os.Remove(temporaryPath)
		}
	}()

	hash := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(temporary, hash), io.LimitReader(source, expectedSize+1))
	if copyErr != nil {
		return Metadata{}, fmt.Errorf("write object: %w", copyErr)
	}
	if written != expectedSize {
		return Metadata{}, ErrSizeMismatch
	}
	actualChecksum := hex.EncodeToString(hash.Sum(nil))
	if actualChecksum != expectedChecksum {
		return Metadata{}, ErrChecksumMismatch
	}
	if err := temporary.Sync(); err != nil {
		return Metadata{}, fmt.Errorf("sync object: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return Metadata{}, fmt.Errorf("close object: %w", err)
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return Metadata{}, fmt.Errorf("commit object bytes: %w", err)
	}
	if err := syncDirectory(filepath.Dir(path)); err != nil {
		_ = os.Remove(path)
		return Metadata{}, err
	}

	createdAt := time.Now().UTC()
	metadata := Metadata{ObjectID: objectID, Checksum: actualChecksum, Size: written, CreatedAt: createdAt, Status: "stored", Path: path}
	if _, err := s.database.ExecContext(ctx, "INSERT INTO objects (object_id,checksum,size,created_at,status,path) VALUES (?,?,?,?,?,?)", objectID, actualChecksum, written, createdAt.Unix(), metadata.Status, path); err != nil {
		_ = os.Remove(path)
		return Metadata{}, fmt.Errorf("commit object metadata: %w", err)
	}
	committed = true
	return metadata, nil
}

func (s *Store) OpenObject(ctx context.Context, objectID string) (io.ReadCloser, Metadata, error) {
	metadata, err := s.Metadata(ctx, objectID)
	if err != nil {
		return nil, Metadata{}, err
	}
	file, err := os.Open(metadata.Path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, Metadata{}, ErrNotFound
	}
	if err != nil {
		return nil, Metadata{}, fmt.Errorf("open object: %w", err)
	}
	return file, metadata, nil
}

func (s *Store) Metadata(ctx context.Context, objectID string) (Metadata, error) {
	if err := ValidateObjectID(objectID); err != nil {
		return Metadata{}, err
	}
	var metadata Metadata
	var createdAt int64
	err := s.database.QueryRowContext(ctx, "SELECT object_id,checksum,size,created_at,status,path FROM objects WHERE object_id=? AND status='stored'", objectID).Scan(&metadata.ObjectID, &metadata.Checksum, &metadata.Size, &createdAt, &metadata.Status, &metadata.Path)
	if errors.Is(err, sql.ErrNoRows) {
		return Metadata{}, ErrNotFound
	}
	if err != nil {
		return Metadata{}, fmt.Errorf("read object metadata: %w", err)
	}
	metadata.CreatedAt = time.Unix(createdAt, 0).UTC()
	return metadata, nil
}

func (s *Store) Delete(ctx context.Context, objectID string) error {
	metadata, err := s.Metadata(ctx, objectID)
	if err != nil {
		return err
	}
	if err := os.Remove(metadata.Path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("delete object bytes: %w", err)
	}
	if _, err := s.database.ExecContext(ctx, "UPDATE objects SET status='deleted' WHERE object_id=?", objectID); err != nil {
		return fmt.Errorf("tombstone object metadata: %w", err)
	}
	return nil
}

func (s *Store) Stats(ctx context.Context) (Stats, error) {
	var used int64
	if err := s.database.QueryRowContext(ctx, "SELECT COALESCE(SUM(size),0) FROM objects WHERE status='stored'").Scan(&used); err != nil {
		return Stats{}, fmt.Errorf("calculate used storage: %w", err)
	}
	available := s.capacity - used
	if available < 0 {
		available = 0
	}
	return Stats{CapacityBytes: s.capacity, UsedBytes: used, AvailableBytes: available}, nil
}

func (s *Store) reserve(ctx context.Context, objectID, checksum string, size int64) (Metadata, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.pending[objectID]; exists {
		return Metadata{}, false, ErrConflict
	}
	if existing, err := s.Metadata(ctx, objectID); err == nil {
		if existing.Checksum == checksum && existing.Size == size {
			return existing, true, nil
		}
		return Metadata{}, false, ErrConflict
	} else if !errors.Is(err, ErrNotFound) {
		return Metadata{}, false, err
	}
	stats, err := s.Stats(ctx)
	if err != nil {
		return Metadata{}, false, err
	}
	if size > stats.AvailableBytes-s.reserved {
		return Metadata{}, false, ErrCapacity
	}
	s.pending[objectID] = struct{}{}
	s.reserved += size
	return Metadata{}, false, nil
}

func (s *Store) release(objectID string, size int64) {
	s.mu.Lock()
	delete(s.pending, objectID)
	s.reserved -= size
	s.mu.Unlock()
}

func (s *Store) objectPath(objectID string) string {
	hash := sha256.Sum256([]byte(objectID))
	name := hex.EncodeToString(hash[:])
	return filepath.Join(s.objectsRoot, name[:2], name)
}

func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open object directory: %w", err)
	}
	defer directory.Close()
	if err := directory.Sync(); err != nil {
		return fmt.Errorf("sync object directory: %w", err)
	}
	return nil
}
