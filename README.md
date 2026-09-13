# Horcrux File System

Horcrux is a client-encrypted distributed file store. The browser secures and reconstructs files, the Hono Worker coordinates identity and metadata, and a headless Go daemon stores opaque objects on laptops. The Worker is the control plane; it is not the shard-data relay.

The control plane never receives plaintext file contents, plaintext or reconstructed AES keys, Shamir share bodies, or encrypted shard bodies.

## Repository

```text
apps/
  web/       React + Vite browser application
  api/       Hono Cloudflare Worker and D1 migrations
  node/      Go laptop storage daemon
packages/
  core/      browser crypto, compression, erasure, secret sharing, pipeline, scheduler
  protocol/  versioned JSON contracts and Ed25519 envelopes
  shared/    IDs, validation, metadata, errors, constants
  storage/   ShardTransport with IndexedDB, memory, and HTTP implementations
integration/ local browser/control-plane signer/Go node path
```

`packages/core` preserves the working crypto/erasure/secret boundaries rather than creating path churn solely to match conceptual package names. Go remains in its own module and is not forced into Bun tooling.

## Data protection pipeline

Uploads remain:

```text
file → zstd level 3 → AES-256-GCM → Reed–Solomon 3 data + 2 parity → five shards
AES key → Shamir Secret Sharing 3-of-5 → five shares
```

The browser distributes the ten opaque objects through `ShardTransport` with at most four active expensive operations. Downloads interleave shard and share candidates through four runners and stop once three valid RS shards and three valid shares are available. Every object checksum, reconstructed ciphertext hash, AES-GCM authentication tag, original size, and original SHA-256 hash is verified.

See [the architecture guide](docs/architecture.md) and [security model](docs/security.md) for trust boundaries, memory behavior, and the direct/STUN/TURN roadmap.

## Local development

Requirements: Bun, Go 1.24+, a C compiler for `go-sqlite3`, and a recent browser.

```bash
bun install
bun run keys:generate
cp apps/api/.dev.vars.example apps/api/.dev.vars
```

Put the generated development keys and a strong `JWT_SECRET` in the ignored `apps/api/.dev.vars`, then initialize D1:

```bash
bun run db:migrate:local
```

Run web and API in separate terminals:

```bash
bun run dev:api
bun run dev:web
```

The browser defaults to `http://localhost:8787` for the Worker and IndexedDB mock storage. Set `VITE_HORCRUX_STORAGE_MODE=http` before starting Vite to use enrolled Go nodes instead. HTTP mode deliberately requires five healthy, distinct physical node identities with fresh heartbeats; it never falls back to mock storage.

## Laptop node

Build and test the headless daemon independently:

```bash
bun run build:node
bun run test:node
```

Create an enrollment challenge while signed into the web API, then run the node once with that challenge. Prefer the environment variable so the one-time secret does not appear in process arguments:

```bash
export HORCRUX_ENROLLMENT_TOKEN='<one-time token>'
./apps/node/horcrux-node \
  --control-plane-public-key '<CAPABILITY_PUBLIC_KEY>' \
  --control-plane-url 'http://127.0.0.1:8787' \
  --enrollment-challenge '<challenge UUID>' \
  --node-name 'My laptop' \
  --listen '0.0.0.0:9443' \
  --advertise-url 'https://192.168.1.42:9443' \
  --tls-cert './node-cert.pem' \
  --tls-key './node-key.pem' \
  --web-origin 'http://192.168.1.10:5173' \
  --data-dir './node-data'
```

The advertised URL is signed into every heartbeat and persisted by D1. It is the URL the browser receives in placement and reconstruction manifests; `--listen` and `--advertise-url` are intentionally separate. Plain HTTP listeners and advertised URLs are restricted to loopback. Configure `--tls-cert` and `--tls-key` for any LAN node, plus the exact allowed browser `--web-origin`. See the physical test procedure below and [the node guide](apps/node/README.md).

## Physical-node LAN test

Laptop A hosts the API and web app. Generate a development TLS certificate trusted by every browser that will connect to a node (for example, `mkcert 192.168.1.42` on each node; do not commit certificates or keys). Configure `WEB_ORIGIN=http://192.168.1.10:5173` in `apps/api/.dev.vars`, run `bun run db:migrate:local`, then start `bun --cwd apps/api dev --ip 0.0.0.0` and `VITE_HORCRUX_STORAGE_MODE=http bun --cwd apps/web dev --host 0.0.0.0`.

Register and sign in through the browser on Laptop A. With its access JWT, create an enrollment challenge:

```bash
curl -X POST http://192.168.1.10:8787/devices/enrollment-challenges \
  -H 'Authorization: Bearer <ACCESS_JWT>'
```

On Laptop B, use the returned `challengeId` and `token` to start the node as in the preceding command, substituting Laptop A's control-plane URL, Laptop A's Vite origin, and Laptop B's LAN address. Check the Devices screen after a heartbeat (normally within 30 seconds): it must show Online and the advertised endpoint. Repeat this on five independently powered laptops (or five separately configured test machines) before uploading in HTTP mode.

Upload and download through the normal Files UI. Node data directories contain only opaque encrypted objects and `metadata.sqlite`; compare the downloaded file with `sha256sum original downloaded`. Five processes on one laptop can exercise placement and recovery mechanics using five ports/data directories, but are not independent failure domains and must not be described as physical fault tolerance.

## Verification

```bash
bun test
bun run typecheck
bun run build:web
bun run build:api
bun run test:node
bun run build:node
bun run test:e2e
bun run test:five-node
```

The integration test starts a real Go daemon on loopback and verifies a TS-issued grant, opaque upload, signed receipt, byte-identical download, authorization rejection, and delete. It needs permission to bind a local port.

`bun run test:five-node` is the local HTTP acceptance test. It starts an ephemeral Wrangler/D1 control plane, applies every migration, enrolls five independently identified Go node processes on dynamically allocated loopback ports, uploads through the browser-compatible core pipeline and `HttpShardTransport`, verifies two opaque objects per node, reconstructs with all nodes, terminates two processes and reconstructs again, then verifies a clear failure after a third process stops. It needs permission to bind local ports and does not persist secrets or node data.

## Cloudflare deployment

1. Create D1 and set its production ID in `apps/api/wrangler.jsonc`.
2. Apply both migrations remotely.
3. Store `JWT_SECRET` and `CAPABILITY_PRIVATE_KEY` with `wrangler secret put`; never commit them or place production values in Wrangler vars.
4. Configure `CAPABILITY_PUBLIC_KEY` and `WEB_ORIGIN` for the Worker environment.
5. Deploy the Worker and build the web app with its `VITE_API_URL`.

Review cookie `SameSite`, CORS, CSRF, node certificate distribution, and allowed origins before a public deployment.

## API overview

```text
POST   /auth/register | /auth/login | /auth/refresh | /auth/logout
GET    /auth/me
GET    /devices
POST   /devices/enrollment-challenges
POST   /nodes/enroll
POST   /nodes/:id/heartbeat
POST   /nodes/:id/capabilities
POST   /nodes/:id/receipts
POST   /files/init | /files/:id/state | /files/:id/complete
GET    /files | /files/:id | /files/:id/download-manifest
DELETE /files/:id
```

Browser-facing routes require the short-lived access JWT. Node enrollment consumes a one-time challenge. Heartbeats and receipts are authenticated by the node’s Ed25519 signature.
