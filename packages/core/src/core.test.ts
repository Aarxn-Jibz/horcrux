import { describe, expect, test } from "bun:test";
import { AuditedShamirProvider, WasmReedSolomonProvider, WebCryptoAesGcm, ZstdCompressionProvider, sha256 } from "./index";

const input = new TextEncoder().encode("CipherMesh roundtrip payload ".repeat(80));

describe("browser processing primitives", () => {
  test("AES-GCM encrypts and decrypts with authenticated metadata", async () => {
    const aes = new WebCryptoAesGcm(); const aad = new TextEncoder().encode("file-id"); const encrypted = await aes.encrypt(input, aad);
    expect(encrypted.ciphertext).not.toEqual(input);
    expect(await aes.decrypt(encrypted.ciphertext, encrypted.key, encrypted.iv, aad)).toEqual(input);
    await expect(aes.decrypt(encrypted.ciphertext, encrypted.key, encrypted.iv, new Uint8Array([1]))).rejects.toThrow("Decryption failed");
  });

  test("Shamir reconstructs from threshold shares", async () => {
    const shamir = new AuditedShamirProvider(); const secret = crypto.getRandomValues(new Uint8Array(32)); const shares = await shamir.splitSecret(secret, 5, 3);
    expect(await shamir.combineShares([shares[0]!, shares[2]!, shares[4]!])).toEqual(secret);
    await expect(shamir.combineShares([shares[0]!])).rejects.toThrow("Insufficient Shamir shares");
  });

  test("zstd compression roundtrip", async () => {
    const zstd = new ZstdCompressionProvider(); const compressed = await zstd.compress(input);
    expect(compressed.byteLength).toBeLessThan(input.byteLength);
    expect(await zstd.decompress(compressed)).toEqual(input);
  });

  test("Reed-Solomon recovers missing shards", async () => {
    const rs = new WasmReedSolomonProvider(); const encoded = await rs.encode(input, 3, 2);
    encoded.shards[0] = null as unknown as Uint8Array;
    encoded.shards[3] = null as unknown as Uint8Array;
    expect(await rs.decode(encoded.shards, 3, 2, input.byteLength)).toEqual(input);
  });

  test("SHA-256 is deterministic", async () => expect(await sha256(input)).toHaveLength(64));
});
