package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/horcrux-file-system/horcrux/apps/node/internal/authorization"
	"github.com/horcrux-file-system/horcrux/apps/node/internal/config"
	"github.com/horcrux-file-system/horcrux/apps/node/internal/enrollment"
	"github.com/horcrux-file-system/horcrux/apps/node/internal/heartbeat"
	"github.com/horcrux-file-system/horcrux/apps/node/internal/identity"
	"github.com/horcrux-file-system/horcrux/apps/node/internal/server"
	"github.com/horcrux-file-system/horcrux/apps/node/internal/storage"
	webrtcnode "github.com/horcrux-file-system/horcrux/apps/node/internal/webrtc"
)

func main() {
	args := os.Args[1:]
	if len(args) == 0 || args[0] == "start" || args[0] == "status" || args[0] == "join" {
		runCommand(args)
		return
	}
	configuration, err := config.Parse(args)
	if err != nil {
		fatal("invalid configuration", err)
	}
	nodeIdentity, err := identity.LoadOrCreate(configuration.DataDirectory)
	if err != nil {
		fatal("initialize node identity", err)
	}
	if configuration.EnrollmentChallenge != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		response, enrollErr := enrollment.Enroll(ctx, enrollment.Request{ControlPlaneURL: configuration.ControlPlaneURL, Transport: configuration.Transport, ChallengeID: configuration.EnrollmentChallenge, Token: configuration.EnrollmentToken, Name: configuration.NodeName, CapacityBytes: configuration.CapacityBytes, Identity: nodeIdentity})
		cancel()
		if enrollErr != nil {
			fatal("enroll node", enrollErr)
		}
		if response.NodeID != nodeIdentity.NodeID {
			fatal("enroll node", errors.New("enrollment returned a different node identity"))
		}
	}
	run(configuration, nodeIdentity)
}

func runCommand(args []string) {
	command := "start"
	if len(args) > 0 {
		command = args[0]
	}
	if command == "join" {
		configuration, token, configDirectory, err := config.ParseJoin(args[1:])
		if err != nil {
			fatal("invalid join command", err)
		}
		if _, err := config.Load(configDirectory); err == nil {
			fatal("already enrolled", errors.New("use 'horcrux-node start' or 'horcrux-node status'"))
		} else if !errors.Is(err, config.ErrNotEnrolled) {
			fatal("load saved node configuration", err)
		}
		fmt.Println("Horcrux Node\n\nCreating device identity...")
		nodeIdentity, err := identity.LoadOrCreate(configDirectory)
		if err != nil {
			fatal("create device identity", err)
		}
		fmt.Println("Device identity ready.\n\nEnrolling device...")
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		response, err := enrollment.Enroll(ctx, enrollment.Request{ControlPlaneURL: token.ControlPlaneURL, Transport: configuration.Transport, ChallengeID: token.ChallengeID, Token: token.Token, Name: configuration.NodeName, CapacityBytes: configuration.CapacityBytes, Identity: nodeIdentity})
		cancel()
		if err != nil {
			fatal("device enrollment failed", err)
		}
		if response.NodeID != nodeIdentity.NodeID {
			fatal("device enrollment failed", errors.New("control plane returned a different device identity"))
		}
		if err := config.Save(configDirectory, configuration); err != nil {
			fatal("save node configuration", err)
		}
		fmt.Printf("Device enrolled successfully.\n\nNode ID: %s\nTransport: %s\nStorage: %s\nCapacity: %d bytes\nConfig: %s\n\nConnecting to Horcrux...\n", nodeIdentity.NodeID, configuration.Transport, configuration.DataDirectory, configuration.CapacityBytes, configDirectory)
		run(configuration, nodeIdentity)
		return
	}
	configDirectory, err := commandConfigDirectory(args[1:])
	if err != nil {
		fatal("invalid command", err)
	}
	configuration, err := config.Load(configDirectory)
	if err != nil {
		fatal("load node configuration", err)
	}
	nodeIdentity, err := identity.Load(configDirectory)
	if err != nil {
		fatal("load device identity", err)
	}
	if command == "status" {
		fmt.Printf("Horcrux Node\nNode ID: %s\nEnrollment: enrolled\nServer: %s\nStorage: %s\nCapacity: %d bytes\nTransport: %s\nVersion: %s\nConfig: %s\n", nodeIdentity.NodeID, configuration.ControlPlaneURL, configuration.DataDirectory, configuration.CapacityBytes, configuration.Transport, server.Version, configDirectory)
		return
	}
	if command != "start" {
		fatal("invalid command", errors.New("use join, start, or status"))
	}
	fmt.Printf("Horcrux Node\nNode ID: %s\nConnecting to Horcrux...\n", nodeIdentity.NodeID)
	run(configuration, nodeIdentity)
}

func commandConfigDirectory(args []string) (string, error) {
	defaults, _, err := config.DefaultDirectories()
	if err != nil {
		return "", err
	}
	set := flag.NewFlagSet("horcrux-node", flag.ContinueOnError)
	directory := defaults
	set.StringVar(&directory, "config-dir", defaults, "directory for node identity and configuration")
	if err := set.Parse(args); err != nil {
		return "", err
	}
	if set.NArg() != 0 {
		return "", errors.New("unexpected arguments")
	}
	return directory, nil
}

func fatal(action string, err error) { slog.Error(action, "error", err); os.Exit(1) }

func run(configuration config.Config, nodeIdentity *identity.Identity) {
	controlPlanePublicKey, err := authorization.ParsePublicKey(configuration.ControlPlanePublicKey)
	if err != nil {
		fatal("parse control-plane public key", err)
	}
	objectStore, err := storage.Open(configuration.DataDirectory, configuration.CapacityBytes)
	if err != nil {
		fatal("open node storage", err)
	}
	defer objectStore.Close()
	verifier := authorization.Verifier{PublicKey: controlPlanePublicKey, NodeID: nodeIdentity.NodeID, Issuer: "horcrux-control-plane"}
	daemon := server.New(configuration.ListenAddress, configuration.MaxConcurrent, nodeIdentity.NodeID, objectStore, verifier, nodeIdentity, configuration.TLSCertificate, configuration.TLSKey, configuration.WebOrigin)
	shutdownContext, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if configuration.ControlPlaneURL != "" {
		var connected sync.Once
		reporter := &heartbeat.Reporter{ControlPlaneURL: configuration.ControlPlaneURL, NodeID: nodeIdentity.NodeID, NodeVersion: server.Version, Transport: configuration.Transport, Endpoint: configuration.AdvertiseURL, Interval: configuration.HeartbeatInterval, Stats: objectStore, Signer: nodeIdentity, Delete: func(ctx context.Context, task heartbeat.DeletionTask) error {
			if _, err := verifier.Verify(task.Capability, "DELETE", task.ObjectID); err != nil {
				return err
			}
			return objectStore.Delete(ctx, task.ObjectID)
		}, OnError: func(err error) { slog.Warn("heartbeat failed", "error", err) }, OnSuccess: func() { connected.Do(func() { slog.Info("connected; waiting for storage requests") }) }}
		go reporter.Run(shutdownContext)
		go (&webrtcnode.Service{Manager: webrtcnode.NewManager(nil), Signals: &webrtcnode.SignalingClient{ControlPlaneURL: configuration.ControlPlaneURL, NodeID: nodeIdentity.NodeID, Signer: nodeIdentity}, NodeID: nodeIdentity.NodeID, Store: objectStore, Verifier: verifier, Signer: nodeIdentity}).Run(shutdownContext)
	}
	go func() {
		<-shutdownContext.Done()
		request, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = daemon.Shutdown(request)
	}()
	slog.Info("horcrux node listening", "node_id", nodeIdentity.NodeID, "address", configuration.ListenAddress, "advertise_url", configuration.AdvertiseURL, "data", configuration.DataDirectory)
	if err := daemon.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		fatal("node stopped unexpectedly", err)
	}
}
