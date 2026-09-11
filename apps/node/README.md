# horcrux-node

This is the headless laptop storage daemon. It runs independently of Bun and any desktop UI.

## Storage

Opaque bytes are streamed into `objects/<hash-prefix>/<object-id-hash>`. `metadata.sqlite` tracks IDs, paths, checksums, sizes, timestamps, and tombstones. `identity.json` holds the long-lived Ed25519 identity at mode `0600`. Back up or protect the complete data directory; do not copy the private identity into Hono or D1.

## HTTP surface

```text
PUT    /objects/:objectId
GET    /objects/:objectId
DELETE /objects/:objectId
GET    /health
```

Every object operation requires `Authorization: Bearer <scoped capability>`. PUT returns a signed storage receipt. Health contains capacity metadata only. The server defaults to six admitted operations and returns `503 node_busy` instead of spawning unbounded goroutines.

Plain HTTP is allowed only on loopback. Remote listeners require `--tls-cert` and `--tls-key`. Browser CORS access is restricted to the exact `--web-origin`.

## Commands

```bash
go test ./...
go vet ./...
go build ./cmd/horcrux-node
go run ./cmd/horcrux-node --help
```

Required runtime configuration is the control-plane Ed25519 public verification key. `--control-plane-url` enables outbound signed heartbeats. Enrollment additionally requires `--enrollment-challenge` and the short-lived `HORCRUX_ENROLLMENT_TOKEN`; the daemon clears that environment variable after the one-shot exchange.

No production WebRTC, STUN, or TURN implementation is included yet. The current direct HTTP API is the local/LAN development transport and the correctness foundation for a future WebRTC data channel.
