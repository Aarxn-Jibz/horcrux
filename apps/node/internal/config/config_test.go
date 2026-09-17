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

func TestEnrollmentConfigurationIsAllOrNothing(t *testing.T) {
	key := []string{"--control-plane-public-key", "test-key"}
	if _, err := Parse(append(key, "--enrollment-challenge", "challenge")); err == nil {
		t.Fatal("enrollment without token was accepted")
	}
	if _, err := Parse(append(key, "--enrollment-token", "token")); err == nil {
		t.Fatal("enrollment without challenge was accepted")
	}
	args := append(key, "--enrollment-challenge", "challenge", "--enrollment-token", "token", "--control-plane-url", "https://control.example", "--advertise-url", "https://192.168.1.42:9443")
	if _, err := Parse(args); err != nil {
		t.Fatalf("complete enrollment configuration was rejected: %v", err)
	}
}

func TestRejectsInvalidBrowserOrigin(t *testing.T) {
	if _, err := Parse([]string{"--control-plane-public-key", "test-key", "--web-origin", "https://app.example/path"}); err == nil {
		t.Fatal("browser origin with a path was accepted")
	}
}

func TestRequiresSecureAdvertisedEndpointForHeartbeats(t *testing.T) {
	key := []string{"--control-plane-public-key", "test-key", "--control-plane-url", "https://control.example"}
	if _, err := Parse(key); err == nil {
		t.Fatal("heartbeat configuration without advertised endpoint was accepted")
	}
	if _, err := Parse(append(key, "--advertise-url", "http://192.168.1.42:9443")); err == nil {
		t.Fatal("insecure LAN advertised endpoint was accepted")
	}
	if _, err := Parse(append(key, "--advertise-url", "https://192.168.1.42:9443")); err != nil {
		t.Fatalf("secure advertised endpoint was rejected: %v", err)
	}
}

func TestWebRTCDoesNotRequireAdvertisedEndpoint(t *testing.T) {
	key := []string{"--control-plane-public-key", "test-key", "--control-plane-url", "https://control.example", "--transport", "webrtc"}
	if _, err := Parse(key); err != nil {
		t.Fatalf("WebRTC configuration rejected without endpoint: %v", err)
	}
}
