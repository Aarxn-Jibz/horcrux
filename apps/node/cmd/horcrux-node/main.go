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

	"github.com/horcrux-file-system/horcrux/apps/node/internal/config"
	"github.com/horcrux-file-system/horcrux/apps/node/internal/identity"
	"github.com/horcrux-file-system/horcrux/apps/node/internal/server"
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
	daemon := server.New(configuration.ListenAddress, configuration.MaxConcurrent, nodeIdentity.NodeID)
	shutdownContext, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
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
