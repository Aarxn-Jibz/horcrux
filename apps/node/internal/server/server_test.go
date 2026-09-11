package server

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/horcrux-file-system/horcrux/apps/node/internal/authorization"
	"github.com/horcrux-file-system/horcrux/apps/node/internal/identity"
	"github.com/horcrux-file-system/horcrux/apps/node/internal/receipt"
	"github.com/horcrux-file-system/horcrux/apps/node/internal/storage"
)

type testNode struct {
	server     *Server
	controlKey ed25519.PrivateKey
	identity   *identity.Identity
	now        time.Time
}

func setupNode(t *testing.T) testNode {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	nodeIdentity, err := identity.LoadOrCreate(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	store, err := storage.Open(t.TempDir(), 1024*1024)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	now := time.Unix(2_000_000_000, 0)
	verifier := authorization.Verifier{PublicKey: publicKey, NodeID: nodeIdentity.NodeID, Issuer: "horcrux-control-plane", Now: func() time.Time { return now }}
	return testNode{server: New("127.0.0.1:0", 6, nodeIdentity.NodeID, store, verifier, nodeIdentity, "", "", "https://app.example"), controlKey: privateKey, identity: nodeIdentity, now: now}
}

func objectChecksum(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

func (node testNode) capability(t *testing.T, operation, objectID string, data []byte) string {
	t.Helper()
	capability := authorization.Capability{Version: authorization.ProtocolVersion, Issuer: "horcrux-control-plane", NodeID: node.identity.NodeID, ObjectID: objectID, Operation: operation, IssuedAt: node.now.Unix(), ExpiresAt: node.now.Add(time.Minute).Unix(), JTI: "request-1234567890"}
	if operation == "PUT" {
		size := int64(len(data))
		capability.Size = &size
		capability.Checksum = objectChecksum(data)
	}
	token, err := authorization.Sign(capability, node.controlKey)
	if err != nil {
		t.Fatal(err)
	}
	return token
}

func perform(handler http.Handler, method, path, token string, body []byte) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, bytes.NewReader(body))
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func TestAuthenticatedObjectLifecycleAndReceipt(t *testing.T) {
	node := setupNode(t)
	objectID := "file-id/shard/object-id"
	data := []byte("opaque encrypted object")
	put := perform(node.server.Handler(), http.MethodPut, "/objects/"+objectID, node.capability(t, "PUT", objectID, data), data)
	if put.Code != http.StatusCreated {
		t.Fatalf("PUT returned %d: %s", put.Code, put.Body.String())
	}
	var stored struct {
		Receipt string `json:"receipt"`
	}
	if err := json.Unmarshal(put.Body.Bytes(), &stored); err != nil {
		t.Fatal(err)
	}
	verifiedReceipt, err := receipt.Verify(stored.Receipt, node.identity.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	if verifiedReceipt.ObjectID != objectID || verifiedReceipt.Checksum != objectChecksum(data) || verifiedReceipt.Size != int64(len(data)) || verifiedReceipt.RequestID != "request-1234567890" {
		t.Fatalf("incorrect receipt: %#v", verifiedReceipt)
	}

	get := perform(node.server.Handler(), http.MethodGet, "/objects/"+objectID, node.capability(t, "GET", objectID, nil), nil)
	if get.Code != http.StatusOK || !bytes.Equal(get.Body.Bytes(), data) || get.Header().Get("X-Object-Checksum") != objectChecksum(data) {
		t.Fatalf("GET mismatch: %d %q", get.Code, get.Body.Bytes())
	}
	deleted := perform(node.server.Handler(), http.MethodDelete, "/objects/"+objectID, node.capability(t, "DELETE", objectID, nil), nil)
	if deleted.Code != http.StatusNoContent {
		t.Fatalf("DELETE returned %d: %s", deleted.Code, deleted.Body.String())
	}
}

func TestObjectAPIRejectsMissingAndWrongScopeCapabilities(t *testing.T) {
	node := setupNode(t)
	objectID := "file/shard/object"
	if response := perform(node.server.Handler(), http.MethodGet, "/objects/"+objectID, "", nil); response.Code != http.StatusUnauthorized {
		t.Fatalf("missing capability returned %d", response.Code)
	}
	wrongObject := node.capability(t, "GET", "unrelated/object", nil)
	if response := perform(node.server.Handler(), http.MethodGet, "/objects/"+objectID, wrongObject, nil); response.Code != http.StatusForbidden {
		t.Fatalf("wrong-object capability returned %d", response.Code)
	}
	expired := authorization.Capability{Version: authorization.ProtocolVersion, Issuer: "horcrux-control-plane", NodeID: node.identity.NodeID, ObjectID: objectID, Operation: "GET", IssuedAt: node.now.Add(-time.Minute).Unix(), ExpiresAt: node.now.Add(-time.Second).Unix(), JTI: "expired-request"}
	expiredToken, err := authorization.Sign(expired, node.controlKey)
	if err != nil {
		t.Fatal(err)
	}
	if response := perform(node.server.Handler(), http.MethodGet, "/objects/"+objectID, expiredToken, nil); response.Code != http.StatusUnauthorized {
		t.Fatalf("expired capability returned %d", response.Code)
	}
}

func TestObjectAPIRejectsChecksumMismatch(t *testing.T) {
	node := setupNode(t)
	objectID := "file/shard/object"
	expected := []byte("expected")
	response := perform(node.server.Handler(), http.MethodPut, "/objects/"+objectID, node.capability(t, "PUT", objectID, expected), []byte("tampered"))
	if response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("checksum mismatch returned %d: %s", response.Code, response.Body.String())
	}
}

func TestBrowserPreflightRequiresConfiguredOrigin(t *testing.T) {
	node := setupNode(t)
	allowed := httptest.NewRequest(http.MethodOptions, "/objects/file/shard/object", nil)
	allowed.Header.Set("Origin", "https://app.example")
	allowedResponse := httptest.NewRecorder()
	node.server.Handler().ServeHTTP(allowedResponse, allowed)
	if allowedResponse.Code != http.StatusNoContent || allowedResponse.Header().Get("Access-Control-Allow-Origin") != "https://app.example" {
		t.Fatalf("allowed preflight returned %d with headers %#v", allowedResponse.Code, allowedResponse.Header())
	}

	denied := httptest.NewRequest(http.MethodOptions, "/objects/file/shard/object", nil)
	denied.Header.Set("Origin", "https://attacker.example")
	deniedResponse := httptest.NewRecorder()
	node.server.Handler().ServeHTTP(deniedResponse, denied)
	if deniedResponse.Code != http.StatusForbidden || deniedResponse.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("disallowed preflight returned %d with headers %#v", deniedResponse.Code, deniedResponse.Header())
	}
}
