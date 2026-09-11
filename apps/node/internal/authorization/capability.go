package authorization

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

const ProtocolVersion = "1"

var (
	ErrInvalidCapability = errors.New("invalid storage capability")
	ErrExpiredCapability = errors.New("storage capability expired")
	ErrWrongNode         = errors.New("storage capability is for another node")
	ErrWrongObject       = errors.New("storage capability is for another object")
	ErrWrongOperation    = errors.New("storage capability does not allow this operation")
)

type Capability struct {
	Version   string `json:"version"`
	Issuer    string `json:"issuer"`
	NodeID    string `json:"nodeId"`
	ObjectID  string `json:"objectId"`
	Operation string `json:"operation"`
	IssuedAt  int64  `json:"issuedAt"`
	ExpiresAt int64  `json:"expiresAt"`
	JTI       string `json:"jti"`
	Checksum  string `json:"checksum,omitempty"`
	Size      *int64 `json:"size,omitempty"`
}

type Verifier struct {
	PublicKey ed25519.PublicKey
	NodeID    string
	Issuer    string
	Now       func() time.Time
}

func ParsePublicKey(encoded string) (ed25519.PublicKey, error) {
	key, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(key) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("%w: public key", ErrInvalidCapability)
	}
	return ed25519.PublicKey(key), nil
}

func (v Verifier) Verify(token, operation, objectID string) (Capability, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 2 || len(v.PublicKey) != ed25519.PublicKeySize {
		return Capability{}, ErrInvalidCapability
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return Capability{}, ErrInvalidCapability
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || !ed25519.Verify(v.PublicKey, payload, signature) {
		return Capability{}, ErrInvalidCapability
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	var capability Capability
	if err := decoder.Decode(&capability); err != nil || decoder.More() {
		return Capability{}, ErrInvalidCapability
	}
	if capability.Version != ProtocolVersion || capability.JTI == "" || capability.Issuer == "" {
		return Capability{}, ErrInvalidCapability
	}
	if v.Issuer != "" && capability.Issuer != v.Issuer {
		return Capability{}, ErrInvalidCapability
	}
	if capability.NodeID != v.NodeID {
		return Capability{}, ErrWrongNode
	}
	if capability.ObjectID != objectID {
		return Capability{}, ErrWrongObject
	}
	if capability.Operation != operation {
		return Capability{}, ErrWrongOperation
	}
	now := time.Now()
	if v.Now != nil {
		now = v.Now()
	}
	nowUnix := now.Unix()
	if capability.ExpiresAt <= nowUnix {
		return Capability{}, ErrExpiredCapability
	}
	if capability.IssuedAt > nowUnix+60 || capability.ExpiresAt <= capability.IssuedAt {
		return Capability{}, ErrInvalidCapability
	}
	if operation == "PUT" && (capability.Checksum == "" || capability.Size == nil || *capability.Size < 0) {
		return Capability{}, ErrInvalidCapability
	}
	return capability, nil
}

func Sign(capability Capability, privateKey ed25519.PrivateKey) (string, error) {
	payload, err := json.Marshal(capability)
	if err != nil {
		return "", err
	}
	signature := ed25519.Sign(privateKey, payload)
	return base64.RawURLEncoding.EncodeToString(payload) + "." + base64.RawURLEncoding.EncodeToString(signature), nil
}
