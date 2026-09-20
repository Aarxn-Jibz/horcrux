package config

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

const stateFilename = "node.json"

var ErrNotEnrolled = errors.New("device is not enrolled")

type JoinToken struct {
	ChallengeID           string `json:"challengeId"`
	Token                 string `json:"token"`
	ControlPlaneURL       string `json:"server"`
	ControlPlanePublicKey string `json:"controlPlanePublicKey"`
}

type persisted struct {
	Config Config `json:"config"`
}

func DefaultDirectories() (string, string, error) {
	configuration, err := os.UserConfigDir()
	if err != nil {
		return "", "", fmt.Errorf("find user configuration directory: %w", err)
	}
	data := os.Getenv("XDG_DATA_HOME")
	if runtime.GOOS == "windows" {
		data = os.Getenv("LOCALAPPDATA")
	}
	if data == "" {
		home, homeErr := os.UserHomeDir()
		if homeErr != nil {
			return "", "", fmt.Errorf("find user data directory: %w", homeErr)
		}
		if runtime.GOOS == "windows" {
			data = configuration
		} else {
			data = filepath.Join(home, ".local", "share")
		}
	}
	return filepath.Join(configuration, "Horcrux"), filepath.Join(data, "Horcrux", "storage"), nil
}

func ParseJoin(args []string) (Config, JoinToken, string, error) {
	if len(args) == 0 {
		return Config{}, JoinToken{}, "", errors.New("usage: horcrux-node join <enrollment-token> [--server URL]")
	}
	defaults, storage, err := DefaultDirectories()
	if err != nil {
		return Config{}, JoinToken{}, "", err
	}
	set := flag.NewFlagSet("join", flag.ContinueOnError)
	configDirectory, serverURL, name, listen := defaults, "", "Horcrux laptop", "127.0.0.1:9443"
	capacity := int64(100 * 1024 * 1024 * 1024)
	set.StringVar(&configDirectory, "config-dir", defaults, "directory for node identity and configuration")
	set.StringVar(&storage, "storage-dir", storage, "directory for stored objects")
	set.StringVar(&serverURL, "server", "", "control-plane URL")
	set.StringVar(&name, "name", name, "device display name")
	set.StringVar(&listen, "listen", listen, "loopback listener address")
	set.Int64Var(&capacity, "capacity-bytes", capacity, "maximum object bytes")
	if err := set.Parse(args[1:]); err != nil {
		return Config{}, JoinToken{}, "", err
	}
	if set.NArg() != 0 {
		return Config{}, JoinToken{}, "", errors.New("join accepts one enrollment token")
	}
	token, err := DecodeJoinToken(args[0])
	if err != nil {
		return Config{}, JoinToken{}, "", err
	}
	if serverURL != "" {
		token.ControlPlaneURL = serverURL
	}
	config := Config{Transport: "webrtc", ListenAddress: listen, DataDirectory: storage, CapacityBytes: capacity, MaxConcurrent: DefaultMaxConcurrent, ControlPlanePublicKey: token.ControlPlanePublicKey, ControlPlaneURL: token.ControlPlaneURL, HeartbeatInterval: 30 * time.Second, NodeName: name, WebOrigin: "http://localhost:5173"}
	if err := validate(config); err != nil {
		return Config{}, JoinToken{}, "", err
	}
	return config, token, configDirectory, nil
}

func DecodeJoinToken(value string) (JoinToken, error) {
	encoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return JoinToken{}, errors.New("enrollment token is malformed; copy the complete token from Horcrux")
	}
	var token JoinToken
	if err := json.Unmarshal(encoded, &token); err != nil || token.ChallengeID == "" || token.Token == "" || token.ControlPlaneURL == "" || token.ControlPlanePublicKey == "" {
		return JoinToken{}, errors.New("enrollment token is malformed; create a new token in Horcrux")
	}
	publicKey, err := base64.RawURLEncoding.DecodeString(token.ControlPlanePublicKey)
	if err != nil || len(publicKey) != ed25519.PublicKeySize {
		return JoinToken{}, errors.New("enrollment token has an invalid control-plane key; create a new token in Horcrux")
	}
	return token, nil
}

func Load(configDirectory string) (Config, error) {
	encoded, err := os.ReadFile(filepath.Join(configDirectory, stateFilename))
	if errors.Is(err, os.ErrNotExist) {
		return Config{}, fmt.Errorf("%w; run: horcrux-node join <enrollment-token>", ErrNotEnrolled)
	}
	if err != nil {
		return Config{}, fmt.Errorf("read saved node configuration: %w", err)
	}
	var state persisted
	if err := json.Unmarshal(encoded, &state); err != nil {
		return Config{}, errors.New("saved node configuration is corrupt; restore it from a backup or enroll a new device")
	}
	if err := validate(state.Config); err != nil {
		return Config{}, fmt.Errorf("saved node configuration is invalid: %w", err)
	}
	return state.Config, nil
}

func Save(configDirectory string, configuration Config) error {
	if err := os.MkdirAll(configDirectory, 0o700); err != nil {
		return fmt.Errorf("create node configuration directory: %w", err)
	}
	encoded, err := json.Marshal(persisted{Config: configuration})
	if err != nil {
		return fmt.Errorf("encode node configuration: %w", err)
	}
	temporary, err := os.CreateTemp(configDirectory, ".node-*")
	if err != nil {
		return fmt.Errorf("create node configuration: %w", err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return fmt.Errorf("protect node configuration: %w", err)
	}
	if _, err := temporary.Write(encoded); err != nil {
		temporary.Close()
		return fmt.Errorf("write node configuration: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close node configuration: %w", err)
	}
	if err := os.Rename(temporaryPath, filepath.Join(configDirectory, stateFilename)); err != nil {
		return fmt.Errorf("save node configuration: %w", err)
	}
	return nil
}

func PreflightDirectory(directory string) error {
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return fmt.Errorf("create node configuration directory: %w", err)
	}
	temporary, err := os.CreateTemp(directory, ".horcrux-preflight-*")
	if err != nil {
		return fmt.Errorf("write node configuration directory: %w", err)
	}
	path := temporary.Name()
	if err := temporary.Close(); err != nil {
		_ = os.Remove(path)
		return fmt.Errorf("close node configuration directory check: %w", err)
	}
	if err := os.Remove(path); err != nil {
		return fmt.Errorf("clean node configuration directory check: %w", err)
	}
	return nil
}
