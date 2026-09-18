package identity

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

const identityFilename = "identity.json"

type Identity struct {
	NodeID     string
	PublicKey  ed25519.PublicKey
	privateKey ed25519.PrivateKey
}

type persistedIdentity struct {
	NodeID     string `json:"nodeId"`
	PublicKey  string `json:"publicKey"`
	PrivateKey string `json:"privateKey"`
}

func LoadOrCreate(dataDirectory string) (*Identity, error) {
	if dataDirectory == "" {
		return nil, errors.New("identity data directory is required")
	}
	if err := os.MkdirAll(dataDirectory, 0o700); err != nil {
		return nil, fmt.Errorf("create identity directory: %w", err)
	}
	path := filepath.Join(dataDirectory, identityFilename)
	identity, err := load(path)
	if err == nil {
		return identity, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generate node identity: %w", err)
	}
	identity = &Identity{NodeID: deriveNodeID(publicKey), PublicKey: publicKey, privateKey: privateKey}
	if err := persist(path, identity); err != nil {
		return nil, err
	}
	return identity, nil
}

func Load(dataDirectory string) (*Identity, error) {
	if dataDirectory == "" {
		return nil, errors.New("identity data directory is required")
	}
	identity, err := load(filepath.Join(dataDirectory, identityFilename))
	if errors.Is(err, os.ErrNotExist) {
		return nil, errors.New("node identity is missing; do not re-enroll over existing storage")
	}
	return identity, err
}

func (i *Identity) PublicKeyBase64() string {
	return base64.RawURLEncoding.EncodeToString(i.PublicKey)
}

func (i *Identity) Sign(payload []byte) []byte {
	return ed25519.Sign(i.privateKey, payload)
}

func load(path string) (*Identity, error) {
	encoded, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var stored persistedIdentity
	if err := json.Unmarshal(encoded, &stored); err != nil {
		return nil, fmt.Errorf("decode node identity: %w", err)
	}
	publicKey, err := base64.RawURLEncoding.DecodeString(stored.PublicKey)
	if err != nil || len(publicKey) != ed25519.PublicKeySize {
		return nil, errors.New("node identity contains an invalid public key")
	}
	privateKey, err := base64.RawURLEncoding.DecodeString(stored.PrivateKey)
	if err != nil || len(privateKey) != ed25519.PrivateKeySize {
		return nil, errors.New("node identity contains an invalid private key")
	}
	if !ed25519.PrivateKey(privateKey).Public().(ed25519.PublicKey).Equal(ed25519.PublicKey(publicKey)) {
		return nil, errors.New("node identity keypair does not match")
	}
	if stored.NodeID != deriveNodeID(publicKey) {
		return nil, errors.New("node identity ID does not match its public key")
	}
	return &Identity{NodeID: stored.NodeID, PublicKey: ed25519.PublicKey(publicKey), privateKey: ed25519.PrivateKey(privateKey)}, nil
}

func persist(path string, identity *Identity) (err error) {
	stored := persistedIdentity{
		NodeID:     identity.NodeID,
		PublicKey:  identity.PublicKeyBase64(),
		PrivateKey: base64.RawURLEncoding.EncodeToString(identity.privateKey),
	}
	encoded, err := json.Marshal(stored)
	if err != nil {
		return fmt.Errorf("encode node identity: %w", err)
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".identity-*")
	if err != nil {
		return fmt.Errorf("create temporary identity: %w", err)
	}
	temporaryPath := temporary.Name()
	committed := false
	temporaryClosed := false
	defer func() {
		if !temporaryClosed {
			if closeErr := temporary.Close(); closeErr != nil {
				err = errors.Join(err, fmt.Errorf("close temporary identity: %w", closeErr))
			}
		}
		if !committed {
			if removeErr := os.Remove(temporaryPath); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
				err = errors.Join(err, fmt.Errorf("remove temporary identity: %w", removeErr))
			}
		}
	}()
	if err := temporary.Chmod(0o600); err != nil {
		return fmt.Errorf("protect node identity: %w", err)
	}
	if _, err := temporary.Write(encoded); err != nil {
		return fmt.Errorf("write node identity: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		return fmt.Errorf("sync node identity: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close node identity: %w", err)
	}
	temporaryClosed = true
	if err := os.Rename(temporaryPath, path); err != nil {
		return fmt.Errorf("commit node identity: %w", err)
	}
	if err := syncDirectory(filepath.Dir(path)); err != nil {
		return err
	}
	committed = true
	return nil
}

func deriveNodeID(publicKey []byte) string {
	digest := sha256.Sum256(publicKey)
	return "node_" + hex.EncodeToString(digest[:16])
}
