# CipherMesh

CipherMesh is a working first vertical slice of a zero-knowledge-style distributed file store. A React browser client compresses, encrypts, erasure-codes, and distributes every file. A Hono Worker on Cloudflare stores only users, authorization state, upload state, and reconstruction metadata in D1. Development storage nodes are durable IndexedDB-backed mocks and can be taken offline from the dashboard.

The master never receives file plaintext, an AES key, a Shamir share, or an encrypted shard body.

## Architecture

```text
apps/web        React + Vite browser application
apps/api        Cloudflare Worker + Hono control plane + D1 migrations
packages/core   Web Crypto, zstd, Reed–Solomon, Shamir, upload/download pipeline
packages/shared Runtime validation, constants, API and device contracts
packages/storage ShardTransport plus memory and IndexedDB mock networks
```

The browser processing code depends only on `ShardTransport`. A future native laptop node can implement the same `putShard`, `getShard`, `deleteShard`, and `healthCheck` contract behind an authenticated HTTP transport. It does not require changes to encryption, erasure coding, or reconstruction. `StorageNodeContract` describes the control-plane view of such a node. Native enrollment, attestation, signed storage receipts, NAT traversal, and peer-to-peer transport are intentionally outside this version.

### Upload

1. The browser validates and reads the selected file, creates a UUID, and hashes the original bytes.
2. The Worker initializes an owned file and expiring upload session and returns eligible nodes.
3. zstd compresses the bytes.
4. Web Crypto generates a random 256-bit AES key and 96-bit IV, then AES-GCM encrypts with the file UUID as authenticated additional data.
5. The encrypted bytes become three data shards and two Reed–Solomon parity shards.
6. The raw binary AES key becomes five Shamir shares with a three-share threshold, then the exported key buffer is zeroed on a best-effort basis.
7. The browser distributes shards and shares through `ShardTransport`. A partial failure rolls back objects already stored.
8. The Worker validates and atomically persists locations, hashes, sizes, algorithms, and reconstruction parameters. It marks the file available only when both configured thresholds are represented.

### Download

1. The browser requests `/files/:id/download-manifest`; the Worker derives identity from the JWT and queries by both file ID and owner ID.
2. The browser fetches mock-node objects and verifies each SHA-256 checksum.
3. At least three valid file shards reconstruct the ciphertext; at least three valid key shares reconstruct the AES key.
4. The browser verifies the full ciphertext hash, authenticates/decrypts AES-GCM, decompresses zstd, and verifies the original byte length and SHA-256 hash.
5. Only then does it create the downloadable `Blob`.

AES-GCM provides confidentiality and authentication. Reed–Solomon provides file redundancy, not secrecy. Shamir protects the AES key with a threshold, not file availability. SHA-256 detects object and roundtrip corruption; it is never used as encryption.

## Database

`apps/api/migrations/0001_initial.sql` creates:

- `users` and salted PBKDF2 password hashes;
- hashed, expiring, rotating, revocable `refresh_tokens`;
- future-facing `devices` with capacity, usage, health, ownership, and public identifier;
- owned `files` containing algorithms, sizes, hashes, thresholds, IV, and lifecycle state;
- expiring `upload_sessions` with initialized/distributing/committing/complete/aborted states;
- `shards` separately from `shard_locations`, allowing replicas later;
- `key_shares`, whose bytes remain only at storage nodes.

Foreign keys prevent orphaned metadata, unique constraints prevent ambiguous indexes or locations, and indexes cover ownership listing, active sessions, and reconstruction lookups. Five global mock devices are seeded for development.

## Browser processing implementations

- AES-G-GCM uses only the browser Web Crypto API.
- [shamir-secret-sharing](https://github.com/privy-io/shamir-secret-sharing) is a browser-compatible, independently audited implementation operating on `Uint8Array`.
- [reed-solomon-erasure.wasm](https://github.com/subspace/reed-solomon-erasure.wasm) wraps the Rust `reed-solomon-erasure` implementation; Vite emits its WASM as a fingerprinted asset.
- [zstd-wasm](https://github.com/bokuweb/zstd-wasm) supplies browser-compatible zstd compression and decompression.

Each is hidden behind an interface so application code does not depend on a particular implementation.

## Local development

Requirements: Bun and a recent browser.

```bash
bun install
cp apps/api/.dev.vars.example apps/api/.dev.vars
# replace JWT_SECRET with a strong random value
bun run db:migrate:local
```

Run the two applications in separate terminals:

```bash
bun run dev:api
bun run dev:web
```

Open `http://localhost:5173`. The web app defaults to `http://localhost:8787`; set `VITE_API_URL` when the Worker uses another origin.

Create an account with a password of at least 12 characters. Upload a file, select it, and reconstruct it. To demonstrate redundancy, switch mock nodes A and B offline after uploading and download again: the default 3+2 Reed–Solomon and 3-of-5 Shamir settings still succeed. Taking three appropriate nodes offline produces a clear threshold error.

Run verification:

```bash
bun test
bun run typecheck
bun run build
```

With the local Worker running, `bun run test:e2e` creates an isolated account, executes an authenticated upload through real D1 routes, retrieves the authorized manifest, disables two in-memory nodes, verifies the reconstructed SHA-256 hash, and tombstones the test file.

Tests cover AES-GCM and authenticated-data failure, Shamir threshold recovery and below-threshold failure, zstd, Reed–Solomon missing-shard recovery, full byte-identical processing, mock node failure/corruption behavior, partial-upload rollback, authentication middleware/password hashing, metadata validation, and ownership filtering.

## Cloudflare deployment

1. Create a D1 database and put its production ID in `apps/api/wrangler.jsonc`.
2. Apply migrations with `bun --cwd apps/api wrangler d1 migrations apply ciphermesh --remote`.
3. Store the JWT secret; never put it in Wrangler vars or Git:

   ```bash
   bun --cwd apps/api wrangler secret put JWT_SECRET
   ```

4. Set `WEB_ORIGIN` to the deployed web origin. Deploy the Worker with `bun --cwd apps/api wrangler deploy`.
5. Build the static client with `VITE_API_URL=https://your-worker.example bun --cwd apps/web build` and deploy `apps/web/dist`.

Production deployments should serve web and API on the same site. If they are on different sites, review cookie `SameSite`, CORS, CSRF protection, and allowed origins before launch.

## API overview

All `/files` and `/devices` routes require `Authorization: Bearer <access JWT>`.

```text
POST   /auth/register
POST   /auth/login
POST   /auth/refresh
POST   /auth/logout
GET    /auth/me
GET    /devices
POST   /files/init
POST   /files/:id/state
POST   /files/:id/complete
GET    /files
GET    /files/:id
GET    /files/:id/shards
GET    /files/:id/download-manifest
DELETE /files/:id
```

Errors consistently use `{ "error": { "code": "...", "message": "..." } }` and appropriate 4xx/5xx status codes.

## Security and known limitations

- Passwords use Web Crypto PBKDF2-HMAC-SHA-256 with a unique 128-bit salt and 310,000 iterations. An Argon2id Worker/WASM adapter is a sensible future upgrade.
- Access JWTs expire after 15 minutes. Thirty-day refresh tokens are random opaque values stored only as SHA-256 hashes, sent as HttpOnly cookies, rotated on use, and revoked on logout.
- Development node storage is IndexedDB in the uploading browser profile. Clearing site data destroys it; another browser cannot retrieve it.
- Mock nodes do not produce cryptographically signed storage receipts. The control plane currently trusts authenticated browser reports that a mock object was stored. Real nodes must sign receipts and authenticate fetch/delete operations.
- Processing is not streaming. zstd and Reed–Solomon currently require complete in-memory buffers, and temporary compression/encryption/shard buffers increase peak memory. The UI enforces a 256 MiB preview limit, but practical limits are device-dependent. Interfaces deliberately accept binary arrays so chunked/streaming implementations can replace them later.
- JavaScript garbage collection prevents guaranteed secret-memory erasure. Key/share buffers are zeroed where ownership is clear, but copies may remain internally.
- Original filenames, MIME types, sizes, hashes, algorithms, placement, and timing are control-plane metadata and are not concealed from the Worker.
- Deleting a file through the same browser removes local mock objects and tombstones metadata. Cleanup of unreachable clients and replicated real-node data will require an asynchronous deletion protocol.
