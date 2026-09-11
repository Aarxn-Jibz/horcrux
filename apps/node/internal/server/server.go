package server

import (
	"context"
	"encoding/json"
	"net/http"
	"time"
)

const Version = "0.1.0-dev"

type Server struct {
	http      *http.Server
	operation chan struct{}
}

func New(address string, maxConcurrent int) *Server {
	server := &Server{operation: make(chan struct{}, maxConcurrent)}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", server.health)
	server.http = &http.Server{
		Addr:              address,
		Handler:           server.limit(mux),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
		WriteTimeout:      5 * time.Minute,
	}
	return server
}

func (s *Server) ListenAndServe() error {
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
			writeJSON(writer, http.StatusServiceUnavailable, map[string]any{"error": map[string]any{"code": "node_busy", "message": "Node operation limit reached", "retryable": true}})
		}
	})
}

func (s *Server) health(writer http.ResponseWriter, _ *http.Request) {
	writeJSON(writer, http.StatusOK, map[string]any{"status": "online", "version": Version})
}

func writeJSON(writer http.ResponseWriter, status int, body any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(body)
}
