import { describe, expect, test } from "bun:test";
import { decodeBase64Url, encodeBase64Url } from "@horcrux-file-system/protocol";
import { deriveNodeId, enrollmentProofPayload, hashOpaqueToken, receiptMatchesCapability, verifyNodeSignature } from "./node-crypto";

describe("node control-plane cryptography", () => {
  test("derives the Go-compatible node ID and verifies enrollment possession", async () => {
    const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const publicKey = encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)));
    const payload = enrollmentProofPayload("challenge-id", "temporary-token", publicKey);
    const signature = encodeBase64Url(new Uint8Array(await crypto.subtle.sign("Ed25519", keys.privateKey, payload)));

    expect(await deriveNodeId(publicKey)).toMatch(/^node_[a-f0-9]{32}$/);
    expect(await verifyNodeSignature(publicKey, payload, signature)).toBeTrue();
    payload[0] = payload[0]! ^ 1;
    expect(await verifyNodeSignature(publicKey, payload, signature)).toBeFalse();
    expect(decodeBase64Url(publicKey)).toHaveLength(32);
  });

  test("hashes enrollment bearer tokens before persistence", async () => {
    expect(await hashOpaqueToken("one-time-secret")).toMatch(/^[a-f0-9]{64}$/);
    expect(await hashOpaqueToken("one-time-secret")).not.toBe("one-time-secret");
  });

  test("binds receipts to the exact issued PUT capability", () => {
    const receipt = {
      version: "1" as const,
      nodeId: "node-a",
      objectId: "file/object",
      checksum: "a".repeat(64),
      size: 42,
      timestamp: 2_000_000_000,
      requestId: "request-id",
    };
    const capability = {
      version: "1" as const,
      issuer: "horcrux-control-plane",
      nodeId: "node-a",
      objectId: "file/object",
      operation: "PUT" as const,
      issuedAt: 1_999_999_900,
      expiresAt: 2_000_000_100,
      jti: "request-id",
      checksum: "a".repeat(64),
      size: 42,
    };
    expect(receiptMatchesCapability(receipt, capability)).toBeTrue();
    expect(receiptMatchesCapability({ ...receipt, objectId: "other/object" }, capability)).toBeFalse();
    expect(receiptMatchesCapability({ ...receipt, checksum: "b".repeat(64) }, capability)).toBeFalse();
  });
});
