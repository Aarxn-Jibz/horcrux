# Horcrux node protocol

The protocol is JSON over authenticated HTTPS. Go and TypeScript implementations use the same field names and wire values documented here; TypeScript types are convenience declarations, not the wire authority.

Capabilities and receipts use a compact Ed25519 envelope:

```text
base64url(raw UTF-8 JSON payload).base64url(Ed25519 signature over those payload bytes)
```

The payload bytes are signed exactly as issued, so verifiers do not need to reproduce JSON key ordering. Times are Unix seconds. Checksums are lowercase SHA-256 hex. Sizes are bytes. `version` is currently `"1"`.

Storage capabilities contain `nodeId`, `objectId`, `operation`, expiration, and `jti`. PUT capabilities also bind the expected checksum and size. Receipts bind `nodeId`, `objectId`, checksum, size, timestamp, and the capability `jti` as `requestId`.

Heartbeat and future signaling payloads contain metadata only. They never contain object bodies, Shamir share bodies, or encryption keys.
