package config

import "testing"

func TestRequiresCapabilityKeyAndSecureRemoteTransport(t *testing.T) {
	if _, err := Parse([]string{}); err == nil {
		t.Fatal("missing control-plane key was accepted")
	}
	if _, err := Parse([]string{"--control-plane-public-key", "test-key", "--listen", "0.0.0.0:9443"}); err == nil {
		t.Fatal("remote plain HTTP listener was accepted")
	}
	if _, err := Parse([]string{"--control-plane-public-key", "test-key", "--listen", "0.0.0.0:9443", "--tls-cert", "cert.pem", "--tls-key", "key.pem"}); err != nil {
		t.Fatalf("TLS remote listener rejected: %v", err)
	}
}

func TestDefaultsUseBoundedConcurrencyAndLoopback(t *testing.T) {
	config, err := Parse([]string{"--control-plane-public-key", "test-key"})
	if err != nil {
		t.Fatal(err)
	}
	if config.MaxConcurrent != DefaultMaxConcurrent || config.ListenAddress != "127.0.0.1:9443" {
		t.Fatalf("unexpected defaults: %#v", config)
	}
}
