import { describe, expect, test } from "bun:test";
import { storageCapabilitySchema, type StorageCapability } from "./index";
import { encodeBase64Url, signEnvelope, verifyEnvelope } from "./envelope";

describe("signed protocol envelopes", () => {
  test("signs exact JSON payload bytes with Ed25519 and rejects tampering", async () => {
    const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const privateKey = encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey)));
    const publicKey = encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)));
    const capability = { version: "1", issuer: "horcrux-control-plane", nodeId: "node-a", objectId: "file/shard/object", operation: "PUT", issuedAt: 2_000_000_000, expiresAt: 2_000_000_060, jti: crypto.randomUUID(), checksum: "a".repeat(64), size: 42 } satisfies StorageCapability;
    const token = await signEnvelope(capability, privateKey);

    expect(await verifyEnvelope(token, publicKey, storageCapabilitySchema)).toEqual(capability);
    await expect(verifyEnvelope(token + "x", publicKey, storageCapabilitySchema)).rejects.toThrow("verification failed");
  });
});
