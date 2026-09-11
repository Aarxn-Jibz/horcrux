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

The browser defaults to `http://localhost:8787` for the Worker. The five development devices are IndexedDB partitions in that browser profile and are clearly labeled as mocks.

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
  --data-dir './node-data'
```

Plain HTTP listeners are restricted to loopback. Configure `--tls-cert` and `--tls-key` for any non-loopback listener, plus the exact allowed browser `--web-origin`. The initial HTTP data plane needs an explicit endpoint resolver in the browser; automatic remote discovery and WebRTC are future work. See [the node guide](apps/node/README.md).

## Verification

```bash
bun test
bun run typecheck
bun run build:web
bun run build:api
bun run test:node
bun run build:node
bun run test:e2e
```

The integration test starts a real Go daemon on loopback and verifies a TS-issued grant, opaque upload, signed receipt, byte-identical download, authorization rejection, and delete. It needs permission to bind a local port.

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
