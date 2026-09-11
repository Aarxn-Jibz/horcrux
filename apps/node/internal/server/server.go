package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/horcrux-file-system/horcrux/apps/node/internal/authorization"
	"github.com/horcrux-file-system/horcrux/apps/node/internal/receipt"
	"github.com/horcrux-file-system/horcrux/apps/node/internal/storage"
)

const Version = "0.1.0-dev"

type Server struct {
	http           *http.Server
	operation      chan struct{}
	nodeID         string
	objects        *storage.Store
	verifier       authorization.Verifier
	receiptSigner  receipt.PayloadSigner
	tlsCertificate string
	tlsKey         string
}

func New(address string, maxConcurrent int, nodeID string, objects *storage.Store, verifier authorization.Verifier, receiptSigner receipt.PayloadSigner, tlsCertificate, tlsKey string) *Server {
	server := &Server{operation: make(chan struct{}, maxConcurrent), nodeID: nodeID, objects: objects, verifier: verifier, receiptSigner: receiptSigner, tlsCertificate: tlsCertificate, tlsKey: tlsKey}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", server.health)
	mux.HandleFunc("PUT /objects/{objectID...}", server.putObject)
	mux.HandleFunc("GET /objects/{objectID...}", server.getObject)
	mux.HandleFunc("DELETE /objects/{objectID...}", server.deleteObject)
	server.http = &http.Server{Addr: address, Handler: server.limit(mux), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second, WriteTimeout: 5 * time.Minute}
	return server
}

func (s *Server) Handler() http.Handler {
	return s.http.Handler
}

func (s *Server) ListenAndServe() error {
	if s.tlsCertificate != "" {
		return s.http.ListenAndServeTLS(s.tlsCertificate, s.tlsKey)
	}
	return s.http.ListenAndServe()
}

func (s *Server) Shutdown(ctx context.Context) error {
	return s.http.Shutdown(ctx)
}

func (s *Server) limit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		select {
		case s.operation <- struct{}{}:
			defer func() { <-s.operation }()
			next.ServeHTTP(writer, request)
		default:
			writeError(writer, http.StatusServiceUnavailable, "node_busy", "Node operation limit reached", true)
		}
	})
}

func (s *Server) health(writer http.ResponseWriter, request *http.Request) {
	stats, err := s.objects.Stats(request.Context())
	if err != nil {
		writeError(writer, http.StatusServiceUnavailable, "storage_unavailable", "Node storage is unavailable", true)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"nodeId": s.nodeID, "status": "online", "version": Version, "capacityBytes": stats.CapacityBytes, "usedBytes": stats.UsedBytes, "availableBytes": stats.AvailableBytes})
}

func (s *Server) putObject(writer http.ResponseWriter, request *http.Request) {
	objectID := request.PathValue("objectID")
	capability, ok := s.authorize(writer, request, "PUT", objectID)
	if !ok {
		return
	}
	if request.ContentLength >= 0 && request.ContentLength != *capability.Size {
		writeError(writer, http.StatusUnprocessableEntity, "size_mismatch", "Object size does not match its capability", false)
		return
	}
	metadata, err := s.objects.Put(request.Context(), objectID, request.Body, capability.Checksum, *capability.Size)
	if err != nil {
		writeStorageError(writer, err)
		return
	}
	signedReceipt, _, err := receipt.Create(s.receiptSigner, s.nodeID, objectID, metadata.Checksum, metadata.Size, capability.JTI, time.Now())
	if err != nil {
		writeError(writer, http.StatusInternalServerError, "receipt_failed", "Object stored but receipt signing failed", true)
		return
	}
	writeJSON(writer, http.StatusCreated, map[string]any{"nodeId": s.nodeID, "objectId": objectID, "checksum": metadata.Checksum, "size": metadata.Size, "receipt": signedReceipt})
}

func (s *Server) getObject(writer http.ResponseWriter, request *http.Request) {
	objectID := request.PathValue("objectID")
	if _, ok := s.authorize(writer, request, "GET", objectID); !ok {
		return
	}
	object, metadata, err := s.objects.OpenObject(request.Context(), objectID)
	if err != nil {
		writeStorageError(writer, err)
		return
	}
	defer object.Close()
	writer.Header().Set("Content-Type", "application/octet-stream")
	writer.Header().Set("Content-Length", strconv.FormatInt(metadata.Size, 10))
	writer.Header().Set("X-Object-Checksum", metadata.Checksum)
	writer.WriteHeader(http.StatusOK)
	_, _ = io.Copy(writer, object)
}

func (s *Server) deleteObject(writer http.ResponseWriter, request *http.Request) {
	objectID := request.PathValue("objectID")
	if _, ok := s.authorize(writer, request, "DELETE", objectID); !ok {
		return
	}
	if err := s.objects.Delete(request.Context(), objectID); err != nil {
		writeStorageError(writer, err)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (s *Server) authorize(writer http.ResponseWriter, request *http.Request, operation, objectID string) (authorization.Capability, bool) {
	header := request.Header.Get("Authorization")
	if !strings.HasPrefix(header, "Bearer ") {
		writeError(writer, http.StatusUnauthorized, "capability_required", "A storage capability is required", false)
		return authorization.Capability{}, false
	}
	capability, err := s.verifier.Verify(strings.TrimPrefix(header, "Bearer "), operation, objectID)
	if err != nil {
		status := http.StatusForbidden
		code := "capability_scope_invalid"
		if errors.Is(err, authorization.ErrExpiredCapability) || errors.Is(err, authorization.ErrInvalidCapability) {
			status = http.StatusUnauthorized
			code = "capability_invalid"
		}
		writeError(writer, status, code, "Storage capability is invalid, expired, or out of scope", false)
		return authorization.Capability{}, false
	}
	return capability, true
}

func writeStorageError(writer http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, storage.ErrInvalidObjectID):
		writeError(writer, http.StatusBadRequest, "invalid_object_id", "Object ID is invalid", false)
	case errors.Is(err, storage.ErrChecksumMismatch):
		writeError(writer, http.StatusUnprocessableEntity, "checksum_mismatch", "Object checksum does not match its capability", false)
	case errors.Is(err, storage.ErrSizeMismatch):
		writeError(writer, http.StatusUnprocessableEntity, "size_mismatch", "Object size does not match its capability", false)
	case errors.Is(err, storage.ErrNotFound):
		writeError(writer, http.StatusNotFound, "object_not_found", "Object not found", false)
	case errors.Is(err, storage.ErrConflict):
		writeError(writer, http.StatusConflict, "object_conflict", "Object ID already contains different bytes", false)
	case errors.Is(err, storage.ErrCapacity):
		writeError(writer, http.StatusInsufficientStorage, "node_out_of_space", "Node does not have enough available space", true)
	default:
		writeError(writer, http.StatusInternalServerError, "storage_error", "Node storage operation failed", true)
	}
}

func writeError(writer http.ResponseWriter, status int, code, message string, retryable bool) {
	writeJSON(writer, status, map[string]any{"error": map[string]any{"code": code, "message": message, "retryable": retryable}})
}

func writeJSON(writer http.ResponseWriter, status int, body any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(body)
}
