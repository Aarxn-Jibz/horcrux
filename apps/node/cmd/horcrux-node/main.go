package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/horcrux-file-system/horcrux/apps/node/internal/authorization"
	"github.com/horcrux-file-system/horcrux/apps/node/internal/config"
	"github.com/horcrux-file-system/horcrux/apps/node/internal/heartbeat"
	"github.com/horcrux-file-system/horcrux/apps/node/internal/identity"
	"github.com/horcrux-file-system/horcrux/apps/node/internal/server"
	"github.com/horcrux-file-system/horcrux/apps/node/internal/storage"
)

func main() {
	configuration, err := config.Parse(os.Args[1:])
	if err != nil {
		slog.Error("invalid configuration", "error", err)
		os.Exit(2)
	}

	nodeIdentity, err := identity.LoadOrCreate(configuration.DataDirectory)
	if err != nil {
		slog.Error("initialize node identity", "error", err)
		os.Exit(1)
	}
	controlPlanePublicKey, err := authorization.ParsePublicKey(configuration.ControlPlanePublicKey)
	if err != nil {
		slog.Error("parse control-plane public key", "error", err)
		os.Exit(1)
	}
	objectStore, err := storage.Open(configuration.DataDirectory, configuration.CapacityBytes)
	if err != nil {
		slog.Error("open node storage", "error", err)
		os.Exit(1)
	}
	defer objectStore.Close()
	verifier := authorization.Verifier{PublicKey: controlPlanePublicKey, NodeID: nodeIdentity.NodeID, Issuer: "horcrux-control-plane"}
	daemon := server.New(configuration.ListenAddress, configuration.MaxConcurrent, nodeIdentity.NodeID, objectStore, verifier, nodeIdentity, configuration.TLSCertificate, configuration.TLSKey)
	shutdownContext, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if configuration.ControlPlaneURL != "" {
		reporter := &heartbeat.Reporter{ControlPlaneURL: configuration.ControlPlaneURL, NodeID: nodeIdentity.NodeID, NodeVersion: server.Version, Interval: configuration.HeartbeatInterval, Stats: objectStore, Signer: nodeIdentity, OnError: func(err error) { slog.Warn("heartbeat failed", "error", err) }}
		go reporter.Run(shutdownContext)
	}
	go func() {
		<-shutdownContext.Done()
		request, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = daemon.Shutdown(request)
	}()

	slog.Info("horcrux node listening", "node_id", nodeIdentity.NodeID, "address", configuration.ListenAddress, "data", configuration.DataDirectory)
	if err := daemon.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		slog.Error("node stopped unexpectedly", "error", err)
		os.Exit(1)
	}
}
