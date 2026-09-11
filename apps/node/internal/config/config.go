package config

import (
	"errors"
	"flag"
	"net"
	"os"
	"time"
)

const DefaultMaxConcurrent = 6

type Config struct {
	ListenAddress         string
	DataDirectory         string
	CapacityBytes         int64
	MaxConcurrent         int
	ControlPlanePublicKey string
	TLSCertificate        string
	TLSKey                string
	ControlPlaneURL       string
	HeartbeatInterval     time.Duration
}

func Parse(args []string) (Config, error) {
	set := flag.NewFlagSet("horcrux-node", flag.ContinueOnError)
	config := Config{}
	set.StringVar(&config.ListenAddress, "listen", "127.0.0.1:9443", "HTTPS listen address")
	set.StringVar(&config.DataDirectory, "data-dir", "./data", "directory owned by this node")
	set.Int64Var(&config.CapacityBytes, "capacity-bytes", 100*1024*1024*1024, "maximum object bytes managed by this node")
	set.IntVar(&config.MaxConcurrent, "max-concurrent", DefaultMaxConcurrent, "maximum concurrent object operations")
	set.StringVar(&config.ControlPlanePublicKey, "control-plane-public-key", os.Getenv("HORCRUX_CONTROL_PLANE_PUBLIC_KEY"), "base64url Ed25519 capability verification key")
	set.StringVar(&config.TLSCertificate, "tls-cert", "", "TLS certificate path")
	set.StringVar(&config.TLSKey, "tls-key", "", "TLS private key path")
	set.StringVar(&config.ControlPlaneURL, "control-plane-url", "", "control-plane base URL for outbound heartbeats")
	set.DurationVar(&config.HeartbeatInterval, "heartbeat-interval", 30*time.Second, "outbound heartbeat interval")
	if err := set.Parse(args); err != nil {
		return Config{}, err
	}
	if config.DataDirectory == "" {
		return Config{}, errors.New("data directory is required")
	}
	if config.CapacityBytes < 1 {
		return Config{}, errors.New("capacity must be positive")
	}
	if config.MaxConcurrent < 1 || config.MaxConcurrent > 64 {
		return Config{}, errors.New("max concurrency must be between 1 and 64")
	}
	if config.HeartbeatInterval < 10*time.Second {
		return Config{}, errors.New("heartbeat interval must be at least 10 seconds")
	}
	if config.ControlPlanePublicKey == "" {
		return Config{}, errors.New("control-plane public key is required")
	}
	if (config.TLSCertificate == "") != (config.TLSKey == "") {
		return Config{}, errors.New("TLS certificate and key must be configured together")
	}
	if config.TLSCertificate == "" {
		host, _, err := net.SplitHostPort(config.ListenAddress)
		if err != nil {
			return Config{}, errors.New("listen address must include host and port")
		}
		ip := net.ParseIP(host)
		if host != "localhost" && (ip == nil || !ip.IsLoopback()) {
			return Config{}, errors.New("plain HTTP is restricted to a loopback address; configure TLS for remote access")
		}
	}
	return config, nil
}
