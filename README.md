# Horcrux File System

> **Client-Encrypted, Zero-Knowledge Distributed File Store**

Horcrux is a high-security distributed file system inspired by secret-sharing cryptography. The browser client compresses, encrypts, erasure-codes, and secret-splits files locally before distributing opaque chunks to a mesh of laptop/edge storage nodes. A Cloudflare Worker coordinates identity, placement metadata, capability grants, and storage receipts without ever receiving file contents or encryption keys.

---

## Key Highlights

- **Zero-Knowledge Control Plane**: The Worker never receives plaintext files, AES keys, Shamir share bodies, or encrypted shard bodies.
- **Client-Side Cryptography**: 
  - File compression via **zstd (level 3)**
  - Authenticated encryption via **AES-256-GCM**
  - Fault-tolerant erasure coding via **Reed-Solomon (3 data + 2 parity)**
  - Key splitting via **Shamir's Secret Sharing (3-of-5 threshold)**
- **Framed v2 Streaming**: Streams files in **1 MiB frames**, eliminating memory caps for large files using the native **File System Access API**.
- **Cryptographic Grants & Receipts**: Edge storage node PUT/GET/DELETE operations require short-lived Ed25519 capabilities; uploads are confirmed via signed node storage receipts.

---

## Architecture Dataflow

```text
                        +------------------------------------+
                        |      Hono / Cloudflare Worker      |
                        |      (Control Plane + D1 DB)       |
                        +------------------------------------+
                           /           |            \
            Auth & Manifests  Capability Grants   Heartbeats & Receipts
                         /             |              \
                        v              v               v
  +----------------------------+             +----------------------------+
  |       Browser Client       |  HTTP REST  |   Go Edge Storage Daemon   |
  |   (React + Core Crypto)    |<----------->|    (Opaque Object Store)   |
  +----------------------------+             +----------------------------+
```

---

## Repository Structure

| Path | Tech Stack | Role & Description |
| :--- | :--- | :--- |
| [`apps/web`](apps/web) | React, Vite, Three.js | Browser application for file management UI, device enrollment, and progressive 3D visualization. |
| [`apps/api`](apps/api) | Hono, Cloudflare D1 | Serverless control plane API handling user auth, node heartbeats, placement manifests, and capability issuance. |
| [`apps/node`](apps/node) | Go 1.24, SQLite | Headless storage daemon managing opaque object storage with atomic disk writes and Ed25519 signatures. |
| [`packages/core`](packages/core) | TypeScript | Core cryptographic pipeline: zstd, AES-256-GCM, Reed-Solomon 3+2, Shamir 3-of-5, and stream schedulers. |
| [`packages/protocol`](packages/protocol) | TypeScript | Versioned JSON schemas and Ed25519 capability/receipt envelope specifications. |
| [`packages/storage`](packages/storage) | TypeScript | `ShardTransport` abstraction (IndexedDB/Memory for dev/test, REST HTTP for real nodes). |
| [`packages/shared`](packages/shared) | TypeScript | Shared constants, validation rules, UUID generators, and custom error types. |
| [`integration`](integration) | TypeScript | Integration tests and 5-node local cluster automated acceptance test harness. |

> [!NOTE]
> `packages/core` preserves cryptographic boundaries without artificial churn. Go daemon code lives in its own module (`apps/node`) and is built independently of Node/Bun tooling.

---

## Data Protection Pipeline

```text
Upload Pipeline:
file ──> zstd (level 3) ──> AES-256-GCM ──> Reed-Solomon (3 data + 2 parity) ──> 5 Encrypted Shards
                                │
AES Key ────────────────────────┴─────────> Shamir Secret Sharing (3-of-5)  ──> 5 Key Shares
```

- **Upload Orchestration**: The browser distributes the **10 opaque objects** (5 shards + 5 key shares) across 5 distinct storage nodes with a max concurrency cap of **4 active operations**.
- **Download Reconstruction**: Downloads query reconstruction manifests and interleave shard/share retrieval across 4 parallel runners. Reconstruction succeeds as soon as **any 3 valid shards and 3 valid shares** arrive. Every object checksum, AES tag, original size, and SHA-256 hash is strictly verified.

---

## File Formats (v1 vs v2)

- **Format v1**: Whole-file in-memory processing. Retains whole-file zstd/AES-GCM layout (capped at 256 MiB).
- **Format v2 (Streaming)**:
  - Reads `File.stream()` in **1 MiB frames**.
  - Compresses each frame with zstd level 3 and encrypts via AES-256-GCM using a 64-bit random per-file nonce prefix + 32-bit frame counter.
  - AAD binds format version, file UUID, original size, frame index, and frame length.
  - Nodes enforce capability-bound stream size reservations; browser writes verified frames incrementally to a `FileSink` (native File System Access API, with 100 MiB Blob fallback).

---

## API Overview

All browser-facing routes require a short-lived access JWT (`Bearer <token>`). Node enrollment uses a single-use token; heartbeats and receipts are authenticated by node Ed25519 signatures.

| Method | Endpoint | Auth Required | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/auth/register` | Public | Register a new user account |
| `POST` | `/auth/login` | Public | Authenticate user and receive access/refresh JWTs |
| `POST` | `/auth/refresh` | Refresh JWT | Refresh short-lived access token |
| `POST` | `/auth/logout` | Access JWT | Invalidate active session |
| `GET` | `/auth/me` | Access JWT | Retrieve authenticated user profile |
| `GET` | `/devices` | Access JWT | List enrolled laptop/edge storage nodes |
| `POST` | `/devices/enrollment-challenges` | Access JWT | Create a 10-minute one-time node enrollment token |
| `POST` | `/nodes/enroll` | Node Signature | Enroll node using single-use challenge token |
| `POST` | `/nodes/:id/heartbeat` | Node Signature | Periodic node health ping (capacity, version, state) |
| `POST` | `/nodes/:id/capabilities` | Access JWT | Issue short-lived PUT/GET/DELETE capabilities |
| `POST` | `/nodes/:id/receipts` | Access JWT | Submit signed storage node receipt to finalize upload |
| `POST` | `/files/init` | Access JWT | Initialize file metadata & fetch eligible placements |
| `GET` | `/files` | Access JWT | List owned files |
| `GET` | `/files/:id` | Access JWT | Fetch file metadata |
| `GET` | `/files/:id/download-manifest` | Access JWT | Fetch reconstruction manifest & GET grants |
| `POST` | `/files/:id/complete` | Access JWT | Mark file upload completed after receipt verification |
| `DELETE` | `/files/:id` | Access JWT | Delete file and issue DELETE capabilities to nodes |

---

## Local Development Setup

### Prerequisites
- **Bun** (v1.0+)
- **Go** (v1.24+)
- **C Compiler** (GCC / Clang for `go-sqlite3`)
- Modern Web Browser (Chrome / Edge / Firefox)

### 1. Initial Setup
```bash
bun install
bun run keys:generate
cp apps/api/.dev.vars.example apps/api/.dev.vars
```

Add the generated development keys and a strong `JWT_SECRET` into `apps/api/.dev.vars`.

### 2. Apply Local Database Migrations
```bash
bun run db:migrate:local
```

### 3. Run Development Servers
Open two terminal windows:
```bash
# Terminal 1: Control Plane Worker API (http://localhost:8787)
bun run dev:api

# Terminal 2: Browser Web App (http://localhost:5173)
bun run dev:web
```

> [!TIP]
> The browser defaults to IndexedDB mock storage. To test real enrolled Go nodes, launch Vite with:
> `VITE_HORCRUX_STORAGE_MODE=http bun run dev:web`

---

## Edge Laptop Node Setup

### Build and Test Daemon
```bash
bun run build:node
bun run test:node
```

### Node Enrollment & Execution
Create an enrollment challenge via the Web API, then run the daemon:

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

---

## Verification & Test Suite

Run the full test suite across all monorepo components:

```bash
# Unit & Type Checks
bun test
bun run typecheck

# Build Checks
bun run build:web
bun run build:api
bun run build:node

# Node & E2E Integration Tests
bun run test:node
bun run test:e2e

# Real 5-Node Local Loopback Test
bun run test:five-node

# 1 GiB Streaming Test (Opt-in)
bun run test:large-file
```

---

## Cloudflare Production Deployment

1. Create a production D1 database and add its ID to `apps/api/wrangler.jsonc`.
2. Apply D1 migrations remotely: `bun --cwd apps/api wrangler d1 migrations apply horcrux-db --remote`.
3. Set secrets: `wrangler secret put JWT_SECRET` and `wrangler secret put CAPABILITY_PRIVATE_KEY`.
4. Set environment variables `CAPABILITY_PUBLIC_KEY` and `WEB_ORIGIN`.
5. Deploy Worker (`bun run build:api`) and host the web application bundle (`apps/web/dist`).

---

## Architecture & Security Docs

For deeper technical details, refer to:
- [Architecture Guide](docs/architecture.md) — Trust boundaries, scheduling, memory model, and WebRTC/STUN/TURN roadmap.
- [Security Model](docs/security.md) — Node identity, cryptographic capabilities, storage receipts, and threat analysis.

