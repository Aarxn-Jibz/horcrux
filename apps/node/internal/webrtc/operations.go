package webrtc

import (
	"context"
	"fmt"
	"github.com/horcrux-file-system/horcrux/apps/node/internal/authorization"
	"github.com/horcrux-file-system/horcrux/apps/node/internal/receipt"
	"github.com/horcrux-file-system/horcrux/apps/node/internal/storage"
	"io"
	"sync"
	"time"
)

// ObjectSession is a single ordered DataChannel operation. Binary messages are
// accepted only between an authorized put-init and exactly one put-finish.
type ObjectSession struct {
	ctx        context.Context
	verifier   authorization.Verifier
	store      *storage.Store
	signer     receipt.PayloadSigner
	nodeID     string
	pipe       *io.PipeWriter
	done       chan result
	capability authorization.Capability
	failure    error
	written    int64
	finished   bool
	mu         sync.Mutex
}
type result struct {
	metadata storage.Metadata
	err      error
}

func NewObjectSession(ctx context.Context, nodeID string, store *storage.Store, verifier authorization.Verifier, signer receipt.PayloadSigner) *ObjectSession {
	return &ObjectSession{ctx: ctx, nodeID: nodeID, store: store, verifier: verifier, signer: signer}
}
func (s *ObjectSession) Begin(control Control) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.pipe != nil || s.finished || control.Type != "put-init" || control.Capability == "" || control.ObjectID == "" {
		return fmt.Errorf("invalid put initialization")
	}
	capability, err := s.verifier.Verify(control.Capability, "PUT", control.ObjectID)
	if err != nil {
		return err
	}
	reader, writer := io.Pipe()
	operationDone := make(chan struct{})
	done := make(chan result, 1)
	s.pipe = writer
	s.capability = capability
	s.done = done
	go func() {
		select {
		case <-s.ctx.Done():
			s.mu.Lock()
			if s.pipe == writer && s.failure == nil {
				s.failure = s.ctx.Err()
			}
			s.mu.Unlock()
			_ = writer.CloseWithError(s.ctx.Err())
		case <-operationDone:
		}
	}()
	go func() {
		var metadata storage.Metadata
		var err error
		if capability.MaxSize != nil {
			metadata, err = s.store.PutBounded(s.ctx, control.ObjectID, reader, *capability.MaxSize)
		} else {
			metadata, err = s.store.Put(s.ctx, control.ObjectID, reader, capability.Checksum, *capability.Size)
		}
		if err != nil {
			s.mu.Lock()
			if s.pipe == writer {
				s.failure = err
			}
			s.mu.Unlock()
			_ = writer.CloseWithError(err)
		}
		_ = reader.Close()
		close(operationDone)
		done <- result{metadata, err}
	}()
	return nil
}
func (s *ObjectSession) Write(chunk []byte) error {
	s.mu.Lock()
	if s.pipe == nil || s.finished || len(chunk) == 0 || len(chunk) > MaxChunkBytes {
		s.mu.Unlock()
		return fmt.Errorf("unexpected binary data")
	}
	s.written += int64(len(chunk))
	if s.capability.MaxSize != nil && s.written > *s.capability.MaxSize {
		s.mu.Unlock()
		return fmt.Errorf("authorized size exceeded")
	}
	pipe := s.pipe
	s.mu.Unlock()
	_, err := pipe.Write(chunk)
	if err != nil {
		s.mu.Lock()
		failure := s.failure
		s.mu.Unlock()
		if failure != nil {
			return failure
		}
	}
	return err
}
func (s *ObjectSession) Finish() (Control, error) {
	s.mu.Lock()
	if s.pipe == nil || s.finished {
		s.mu.Unlock()
		return Control{}, fmt.Errorf("invalid put finish")
	}
	s.finished = true
	pipe := s.pipe
	s.mu.Unlock()
	_ = pipe.Close()
	outcome := <-s.done
	if outcome.err != nil {
		return Control{}, outcome.err
	}
	token, _, err := receipt.Create(s.signer, s.nodeID, outcome.metadata.ObjectID, outcome.metadata.Checksum, outcome.metadata.Size, s.capability.JTI, time.Now())
	if err != nil {
		return Control{}, err
	}
	return Control{Type: "receipt", ObjectID: outcome.metadata.ObjectID, Checksum: outcome.metadata.Checksum, Size: outcome.metadata.Size, Capability: token}, nil
}
func (s *ObjectSession) Abort() {
	s.mu.Lock()
	pipe := s.pipe
	s.pipe = nil
	s.finished = true
	if s.failure == nil {
		s.failure = fmt.Errorf("peer disconnected")
	}
	s.mu.Unlock()
	if pipe != nil {
		_ = pipe.CloseWithError(fmt.Errorf("peer disconnected"))
	}
}
func (s *ObjectSession) Get(control Control, send func([]byte) error) (Control, error) {
	if control.Type != "get" {
		return Control{}, fmt.Errorf("invalid get")
	}
	if _, err := s.verifier.Verify(control.Capability, "GET", control.ObjectID); err != nil {
		return Control{}, err
	}
	file, metadata, err := s.store.OpenObject(s.ctx, control.ObjectID)
	if err != nil {
		return Control{}, err
	}
	defer file.Close()
	if control.Size > 0 {
		seeker, ok := file.(io.Seeker)
		if !ok {
			return Control{}, fmt.Errorf("object is not seekable")
		}
		if _, err = seeker.Seek(control.Size, io.SeekStart); err != nil {
			return Control{}, err
		}
	}
	buffer := make([]byte, MaxChunkBytes)
	for {
		n, readErr := file.Read(buffer)
		if n > 0 {
			if err := send(append([]byte(nil), buffer[:n]...)); err != nil {
				return Control{}, err
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return Control{}, readErr
		}
	}
	return Control{Type: "get-finish", ObjectID: metadata.ObjectID, Checksum: metadata.Checksum, Size: metadata.Size}, nil
}
func (s *ObjectSession) Delete(control Control) error {
	if control.Type != "delete" {
		return fmt.Errorf("invalid delete")
	}
	if _, err := s.verifier.Verify(control.Capability, "DELETE", control.ObjectID); err != nil {
		return err
	}
	return s.store.Delete(s.ctx, control.ObjectID)
}
