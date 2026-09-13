import { describe, expect, test } from "bun:test";
import { enrollmentChallengeSchema, enrollmentProofSchema, heartbeatSchema, storageCapabilitySchema, type NodeHeartbeat, type StorageCapability } from "./index";
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

  test("verifies signed node heartbeat metadata", async () => {
    const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const privateKey = encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey)));
    const publicKey = encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)));
    const heartbeat = {
      version: "1",
      nodeId: "node-a",
      status: "online",
      capacityBytes: 1_000,
      usedBytes: 400,
      availableBytes: 600,
      nodeVersion: "0.1.0",
      endpoint: "https://192.168.1.42:9443",
      timestamp: 2_000_000_000,
    } satisfies NodeHeartbeat;

    expect(await verifyEnvelope(await signEnvelope(heartbeat, privateKey), publicKey, heartbeatSchema)).toEqual(heartbeat);
  });

  test("keeps enrollment challenges short-lived and self-contained", () => {
    const challengeId = crypto.randomUUID();
    expect(enrollmentChallengeSchema.parse({ challengeId, token: "x".repeat(32), expiresAt: "2030-01-01T00:00:00.000Z" })).toBeTruthy();
    expect(enrollmentProofSchema.parse({ challengeId, token: "x".repeat(32), publicKey: "p".repeat(43), signature: "s".repeat(86), name: "Laptop", capacityBytes: 1_000 })).toBeTruthy();
    expect(() => enrollmentProofSchema.parse({ challengeId, publicKey: "p".repeat(43), signature: "s".repeat(86), name: "Laptop", capacityBytes: 1_000 })).toThrow();
  });
});
