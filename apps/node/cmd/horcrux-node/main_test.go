package main

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"testing"
)

func TestConfigDirectoryWithoutStartUsesDefaultCommand(t *testing.T) {
	args := []string{"--config-dir", `C:\Users\Teammate\AppData\Roaming\Horcrux`}
	command, commandArgs := splitCommand(args)
	if command != "start" {
		t.Fatalf("command = %q, want start", command)
	}
	if len(commandArgs) != len(args) || commandArgs[0] != args[0] || commandArgs[1] != args[1] {
		t.Fatalf("arguments changed: %#v", commandArgs)
	}
}

func TestJoinRejectsInvalidStorageBeforeEnrollment(t *testing.T) {
	var requests atomic.Int32
	controlPlane := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { requests.Add(1) }))
	defer controlPlane.Close()
	encoded, err := json.Marshal(map[string]string{"challengeId": "challenge", "token": "one-time-token", "server": controlPlane.URL, "controlPlanePublicKey": base64.RawURLEncoding.EncodeToString(make([]byte, 32))})
	if err != nil {
		t.Fatal(err)
	}
	storagePath := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(storagePath, []byte("file"), 0o600); err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(t.TempDir(), "horcrux-node")
	build := exec.Command("go", "build", "-o", binary, ".")
	build.Env = append(os.Environ(), "GOCACHE=/tmp/horcrux-go-cache", "GOMODCACHE=/tmp/horcrux-go-mod")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build node: %v\n%s", err, output)
	}
	join := exec.Command(binary, "join", base64.RawURLEncoding.EncodeToString(encoded), "--config-dir", t.TempDir(), "--storage-dir", storagePath)
	if err := join.Run(); err == nil {
		t.Fatal("join accepted a file as storage")
	}
	if requests.Load() != 0 {
		t.Fatalf("enrollment was requested %d times", requests.Load())
	}
}
