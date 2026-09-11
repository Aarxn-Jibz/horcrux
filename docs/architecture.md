# Distributed node architecture

## Control plane

Hono on Cloudflare Workers with D1 is the universal control plane. It owns users and sessions, devices, file metadata, upload sessions, placement, reconstruction manifests, enrollment challenges, public node keys, capability issuance, receipt validation, and heartbeat state.

The Worker never accepts an object-body endpoint. Shards and key shares do not pass through it during normal storage or retrieval.

## Data plane

```text
Browser ─── authenticated encrypted object bytes ─── Laptop node
   │                                                   │
   └──────── auth, metadata, grants, signaling ────────┘
                         Hono Worker
```

`ShardTransport` isolates the browser pipeline from transport details:

```text
putShard(nodeId, objectId, bytes)
getShard(nodeId, objectId)
deleteShard(nodeId, objectId)
healthCheck(nodeId)
```

IndexedDB and memory transports support deterministic browser development and tests. `HttpShardTransport` implements direct authenticated REST transfer, requires HTTPS away from loopback, requests an object-scoped grant for each operation, and submits PUT receipts to Hono. A future WebRTC transport fits the same boundary without rewriting compression, encryption, distribution, or reconstruction.

## Upload sequence

1. Validate and hash the selected file.
2. Initialize owned file metadata and obtain eligible placements.
3. Compress with zstd level 3.
4. Encrypt with a fresh AES-256-GCM key and file ID as authenticated data.
5. Encode ciphertext as RS 3+2.
6. Split the AES key as Shamir 3-of-5.
7. Request short-lived PUT capabilities.
8. Distribute all ten objects through a bounded scheduler with concurrency four.
9. Real nodes return signed storage receipts; the browser submits them to Hono.
10. Hono accepts real-node completion only when matching verified receipts exist.
11. Mark the file available and release transient buffers.

Mock IndexedDB nodes are explicitly exempt from signed receipts during development; they are never represented as physical laptops.

## Download sequence

1. Request the owned reconstruction manifest and object-scoped GET grants.
2. Interleave shard and share retrieval across four runners.
3. Validate every returned object SHA-256.
4. Abort or safely ignore remaining work after any three valid shards and three valid shares arrive.
5. Reconstruct and verify the ciphertext, reconstruct the key, authenticate/decrypt, decompress, then verify original size and SHA-256.
6. Create the browser download only after every verification succeeds.

## Node runtime and storage

`horcrux-node` is a headless Go daemon. It treats names, shards, and shares as opaque object IDs and byte streams. It has no dependency on a tray or desktop process.

Bytes live in a content-obscured filesystem layout derived from SHA-256 of the object ID:

```text
data/
  identity.json
  metadata.sqlite
  objects/
    ab/
      <object-id-hash>
```

SQLite tracks object ID, checksum, size, creation time, status, and path. Multi-megabyte object bodies are never SQLite BLOBs. PUT reserves capacity, streams to a temporary file while hashing, checks declared size and checksum, syncs and closes it, atomically renames it, syncs the containing directory, and only then commits metadata. The default server admission limit is six concurrent requests; the browser’s stricter orchestration limit remains four.

## Health and placement

The daemon sends a signed outbound heartbeat about every 30 seconds. Hono never polls arbitrary laptop IP addresses. Heartbeats report node ID, online/degraded state, capacity, used and available bytes, node version, protocol version, and timestamp—never object bytes or secrets.

Initial placement is intentionally deterministic. Real nodes are eligible only when owned by the user, online/degraded, healthy/degraded, protocol version 1, nonempty, and seen within two minutes. Global browser mocks remain eligible for development. Selection prefers lower used/capacity ratio and then stable node ID ordering.

## Networking roadmap

The intended preference is:

```text
1. directly reachable connection
2. STUN-assisted direct WebRTC
3. TURN relay fallback
```

STUN helps endpoints discover public-facing NAT mappings and ICE candidates. It is not Horcrux storage, authentication, encryption, a backend, or a normal shard relay.

TURN is required when carrier-grade NAT, symmetric NAT, strict hotspots, or firewalls defeat direct paths. Both endpoints connect outward and TURN relays already-encrypted object bytes. TURN can observe network metadata, timing, and byte counts, so it is not zero-knowledge with respect to metadata. It must never receive plaintext files or key material, and relay bandwidth has real infrastructure cost.

Implemented now: protocol signaling shapes, direct local/LAN HTTPS semantics, outbound heartbeats, endpoint-independent transports, grants, receipts, and tests. Not implemented now: signaling service, WebRTC data channels, ICE candidate exchange, STUN configuration, TURN credentials/deployment, automatic endpoint discovery, or global relay infrastructure.

## Parallelism and instrumentation

The browser uses fixed-runner queues, not `Promise.all` over large work sets. Upload stores and rollback, plus download retrieval, are bounded to four. Queues preserve association, release completed payload references, propagate failures, and accept cancellation. Tests prove the maximum never exceeds four and reaches four with sufficient work.

Local advanced details expose actual stage durations, configured concurrency, and maximum observed transfer concurrency. No external telemetry is sent and no benchmark values are invented.

## Memory model

Processing is still whole-file and capped at 256 MiB. Large references are cleared after each ownership boundary. Reed–Solomon shards are views over one contiguous allocation until a transport needs ownership; IndexedDB copies only narrow views to avoid retaining the complete backing store. Queues discard tasks, and binary data never enters React state or logs.

Peak memory still includes the browser file read, active codec/ciphertext buffers, Reed–Solomon storage, IndexedDB serialization, and WASM linear memory. Compression, hashing, and RS workers were evaluated but intentionally not added: multiple WASM instances and transfers would raise peak memory and lifecycle complexity without fixing the whole-file limit. Web Crypto remains on the browser API. Streaming/chunked formats are the meaningful future OOM improvement.

## Future work

- chunked/streaming compression, encryption framing, hashing, and erasure coding;
- production WebRTC signaling and data-channel transport;
- STUN configuration and a measured TURN fallback deployment;
- OS keystore integration and an optional tray UI around the headless daemon;
- replica repair, rebalancing, distributed garbage collection, and deletion acknowledgements;
- certificate/endpoint discovery and protocol upgrade negotiation.
