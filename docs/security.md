# Security model

## Independent protection layers

Client-side AES-256-GCM protects stored object content. HTTPS or WebRTC DTLS protects object bytes and authorization tokens in transit. Neither replaces the other.

The Worker may learn user identity, filenames, MIME types, sizes, hashes, algorithms, placement, timing, device health, and access patterns. It must not learn file plaintext, AES keys, reconstructed keys, Shamir share bodies, or shard bodies. A future TURN operator additionally observes relay endpoints, timing, and encrypted byte counts.

## Identity and enrollment

Each node generates a long-lived Ed25519 keypair. The private key stays in `identity.json` under the configured node data directory with mode `0600`; it is never uploaded to Hono. The node ID is deterministically derived from the first 16 bytes of SHA-256 over its raw public key.

The current local mechanism is explicit and portable, not an OS keystore. Protect the node data directory with normal full-disk encryption and account permissions. OS credential-store integration is future hardening.

Enrollment uses an authenticated user-created, random, ten-minute challenge. D1 stores only the token hash. The node signs the exact challenge ID, token, and public key. Hono conditionally claims the unused challenge before recording the public key, so concurrent replays cannot enroll a second identity. Arbitrary users cannot enroll under another owner, and the bearer token is not permanent.

## Capabilities

Hono signs compact Ed25519 capabilities. Nodes need only the control-plane public key. A grant binds protocol version, issuer, node ID, object ID, operation, issued/expiry times, and random `jti`. Legacy exact PUTs bind SHA-256 and size. Streamed v2 PUTs instead bind a positive maximum size and deliberately cannot carry client-declared final metadata. The default lifetime is five minutes.

Capabilities are retryable until expiry. This is deliberate: PUT is idempotent only for identical checksum/size, GET is read-only, and DELETE becomes a not-found result after success. Nodes do not maintain an unbounded global nonce database. Hono records issued grants; a stricter distributed replay cache can be added if a future operation gains non-idempotent effects.

The browser never receives a node master password. A PUT grant for object X cannot read, overwrite a different ID, or delete unrelated data. Object APIs reject missing, expired, wrongly signed, wrong-node, wrong-object, and wrong-operation grants.

## Receipts

After durable PUT semantics complete, the node signs a receipt containing version, node ID, object ID, checksum, size, timestamp, and the capability `jti` as `requestId`. Receipts contain no object or key bytes.

Hono verifies the registered node public key, issued PUT scope, expiry, owner/file, and a bounded timestamp window. Exact legacy receipts must match their issued checksum and size; streamed receipts must be node-attested and no larger than their signed authorization bound. D1 uniqueness on request ID and node/object prevents receipt replay from confirming unrelated work. Real-node file completion requires matching receipts; browser mocks retain an explicit development-only exception.

## Storage safety

Object IDs are validated independently of filesystem paths and reject empty, dot, and traversal segments. Disk paths are hashes of object IDs. Uploads are size-limited by the grant, streamed while hashing, and not declared successful until temporary-file sync, atomic rename, directory sync, and SQLite metadata commit complete.

The daemon bounds request concurrency and capacity reservations. It does not accept arbitrary paths, unauthenticated object operations, non-loopback plaintext listeners, or unconfigured browser origins.

## Browser limitations

JavaScript cannot guarantee physical secret erasure. Owned key, share, plaintext, compressed, ciphertext, and shard references are cleared or zeroed as soon as practical, but browser, Web Crypto, WASM, IndexedDB, and garbage-collector internals may retain copies. Binary payloads are never stored in React state or emitted to logs.

The current 256 MiB limit is an application guard, not a proof that every device has enough memory. Users on constrained browsers can still exhaust memory. Prefer predictable bounded concurrency over maximum throughput; future chunked formats must retain authentication and reconstruction guarantees.
