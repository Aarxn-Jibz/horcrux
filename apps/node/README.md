# horcrux-node

This is the headless laptop storage daemon. It runs independently of Bun and any desktop UI.

## Run a teammate node

Download the binary for your platform, create a one-time enrollment token in Horcrux, then run:

```text
horcrux-node.exe join <enrollment-token>
```

`join` creates the device identity, enrolls once, saves non-secret configuration, starts WebRTC and heartbeats, and reports `connected; waiting for storage requests` after the first accepted heartbeat. Later starts need no token:

```text
horcrux-node.exe
horcrux-node.exe status
```

For a test install or a custom drive, use `--config-dir` and `--storage-dir` during `join`; use the same `--config-dir` with `start` or `status`.

On Windows the identity and `node.json` are in `%AppData%\Horcrux`; objects are in `%LocalAppData%\Horcrux\storage`. On Linux they are in `$XDG_CONFIG_HOME/Horcrux` (normally `~/.config/Horcrux`) and `$XDG_DATA_HOME/Horcrux/storage` (normally `~/.local/share/Horcrux/storage`). The enrollment token is never saved.

Manual smoke test: download `horcrux-node-windows-amd64.exe` (or a Linux binary), get a token from the Horcrux device-enrollment screen/API, run `horcrux-node.exe join <token>`, verify the device turns online, stop it, run `horcrux-node.exe`, verify the same Node ID returns online, then upload and download a file through that device.

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

Plain HTTP is allowed only on loopback. Remote HTTP listeners require `--tls-cert` and `--tls-key`; WebRTC nodes can use the default loopback listener without an advertised storage endpoint. Browser CORS access is restricted to the exact `--web-origin`.

## Commands

```bash
go test ./...
go vet ./...
go build ./cmd/horcrux-node
go run ./cmd/horcrux-node --help
```

The simple join token contains the one-time enrollment credential, control-plane URL, and public capability verification key. Select `--transport webrtc` in the legacy flag mode for the direct-connectivity path; it enables signed heartbeats and WebRTC signaling without `--advertise-url` or TLS. HTTP transport still requires `--advertise-url`, an absolute browser-reachable HTTPS origin (loopback HTTP is only allowed for local development). Heartbeats report capacity/health and pull bounded, object-scoped deletion tasks; each task is verified with the control-plane DELETE capability and acknowledged on the next heartbeat.

The daemon also serves authenticated WebRTC data-channel transfers through the control plane's signaling relay. Direct HTTP remains available for local/LAN use. STUN and TURN configuration are not included.
