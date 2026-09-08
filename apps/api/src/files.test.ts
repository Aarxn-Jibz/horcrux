import { describe, expect, test } from "bun:test";
import { fileCommitSchema, fileInitSchema } from "@ciphermesh/shared";
import { getOwnedFile, serializeFile, type FileRow } from "./data/files";

const row: FileRow = { id: "file-1", owner_user_id: "owner-1", original_name: "hello.txt", mime_type: "text/plain", original_size: 5, compressed_size: null, encrypted_size: null, plaintext_hash: "a".repeat(64), ciphertext_hash: null, status: "uploading", encryption_algorithm: "AES-256-GCM", compression_algorithm: "zstd", encryption_iv: null, rs_data_shards: 3, rs_parity_shards: 2, rs_shard_size: null, key_share_threshold: 3, key_share_count: 5, created_at: "2026-01-01" };
function database(result: FileRow | null) { return { prepare: () => ({ bind: (...params: unknown[]) => ({ first: async () => params[1] === result?.owner_user_id ? result : null }) }) } as unknown as D1Database; }

describe("file metadata and ownership", () => {
  test("accepts valid metadata creation and rejects invalid thresholds", () => {
    const metadata = { fileId: crypto.randomUUID(), originalName: "hello.txt", mimeType: "text/plain", originalSize: 5, plaintextHash: "a".repeat(64), dataShards: 3, parityShards: 2, keyShareThreshold: 3, keyShareCount: 5 };
    expect(fileInitSchema.safeParse(metadata).success).toBeTrue();
    expect(fileInitSchema.safeParse({ ...metadata, keyShareThreshold: 6 }).success).toBeFalse();
    expect(fileCommitSchema.safeParse({ compressedSize: 5, encryptedSize: 21, ciphertextHash: "b".repeat(64), encryptionIv: "abcdefghijklmnop", shardSize: 7, objects: [] }).success).toBeFalse();
  });

  test("returns only a file owned by the authenticated user", async () => {
    expect((await getOwnedFile(database(row), row.id, "owner-1")).id).toBe(row.id);
    await expect(getOwnedFile(database(row), row.id, "attacker")).rejects.toMatchObject({ status: 404, code: "file_not_found" });
    expect(serializeFile(row)).not.toHaveProperty("owner_user_id");
  });
});
