package receipt

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

const ProtocolVersion = "1"

var ErrInvalidReceipt = errors.New("invalid storage receipt")

type Receipt struct {
	Version   string `json:"version"`
	NodeID    string `json:"nodeId"`
	ObjectID  string `json:"objectId"`
	Checksum  string `json:"checksum"`
	Size      int64  `json:"size"`
	Timestamp int64  `json:"timestamp"`
	RequestID string `json:"requestId"`
}

type PayloadSigner interface {
	Sign(payload []byte) []byte
}

func Create(signer PayloadSigner, nodeID, objectID, checksum string, size int64, requestID string, now time.Time) (string, Receipt, error) {
	receipt := Receipt{Version: ProtocolVersion, NodeID: nodeID, ObjectID: objectID, Checksum: checksum, Size: size, Timestamp: now.UTC().Unix(), RequestID: requestID}
	payload, err := json.Marshal(receipt)
	if err != nil {
		return "", Receipt{}, err
	}
	signature := signer.Sign(payload)
	token := base64.RawURLEncoding.EncodeToString(payload) + "." + base64.RawURLEncoding.EncodeToString(signature)
	return token, receipt, nil
}

func Verify(token string, publicKey ed25519.PublicKey) (Receipt, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return Receipt{}, ErrInvalidReceipt
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return Receipt{}, ErrInvalidReceipt
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || !ed25519.Verify(publicKey, payload, signature) {
		return Receipt{}, ErrInvalidReceipt
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	var receipt Receipt
	if err := decoder.Decode(&receipt); err != nil || receipt.Version != ProtocolVersion || receipt.NodeID == "" || receipt.ObjectID == "" || receipt.Checksum == "" || receipt.RequestID == "" || receipt.Size < 0 {
		return Receipt{}, ErrInvalidReceipt
	}
	return receipt, nil
}
