import { describe, expect, test } from "bun:test";
import { fileCommitSchema, fileInitSchema } from "@horcrux-file-system/shared";
import app from "./index";
import { getOwnedFile, serializeFile, type FileRow } from "./data/files";
import type { Env } from "./env";
import { issueAccessToken } from "./lib/tokens";

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

class CompletionRaceDatabase {
  file = { ...row, id: "file-race", owner_user_id: "user-a", rs_data_shards: 1, rs_parity_shards: 1, key_share_threshold: 2, key_share_count: 2 };
  session = { expires_at: new Date(Date.now() + 60_000).toISOString(), status: "initialized" };

  constructor(private readonly terminalState: "aborted" | "deleted") {}

  prepare(query: string) {
    const database = this;
    const statement = {
      query,
      bind(..._values: unknown[]) { return statement; },
      async first() {
        if (query.includes("FROM files")) return { ...database.file };
        if (query.includes("FROM upload_sessions")) {
          const session = { ...database.session };
          database.session.status = "aborted";
          database.file.status = database.terminalState === "aborted" ? "failed" : "deleted";
          return session;
        }
        if (query.includes("FROM devices")) return { public_key: null, receipt_id: null };
        return null;
      },
      async run() { return { meta: { changes: 0 } }; },
    };
    return statement as unknown as D1PreparedStatement;
  }

  async batch(statements: D1PreparedStatement[]) {
    for (const statement of statements as unknown as Array<{ query?: string }>) {
      if (statement.query?.startsWith("UPDATE files SET")) this.file.status = "available";
      if (statement.query?.startsWith("UPDATE upload_sessions SET") && this.session.status !== "aborted") this.session.status = "complete";
    }
    return [];
  }
}

describe("upload completion races", () => {
  test.each(["aborted", "deleted"] as const)("does not resurrect a %s upload after a stale completion read", async (terminalState) => {
    const database = new CompletionRaceDatabase(terminalState);
    const env: Env = { DB: database as unknown as D1Database, JWT_SECRET: "test-secret-that-is-long-and-random", WEB_ORIGIN: "http://localhost:5173" };
    const token = await issueAccessToken("user-a", "owner@example.com", env.JWT_SECRET);
    const object = (kind: "shard" | "key-share", index: number) => ({ id: crypto.randomUUID(), kind, index, nodeId: "mock-a", objectId: `object-${kind}-${index}`, size: 1, checksum: "b".repeat(64), ...(kind === "shard" ? { shardType: "data" as const } : {}), status: "stored" as const });
    const response = await app.request(`http://api/files/${database.file.id}/complete`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ compressedSize: 1, encryptedSize: 17, ciphertextHash: "c".repeat(64), encryptionIv: "abcdefghijklmnop", shardSize: 17, objects: [object("shard", 0), object("key-share", 0), object("key-share", 1)] }),
    }, env);

    expect(response.status).toBe(409);
    expect(database.file.status).toBe(terminalState === "aborted" ? "failed" : "deleted");
    expect(database.session.status).toBe("aborted");
  });
});

class DeletionDatabase {
  file = { ...row, id: "file-delete", owner_user_id: "user-a", status: "available" as const, deletion_state: null as "pending" | null };
  readonly batches: Array<Array<{ query: string; bindings: unknown[] }>> = [];

  constructor(private readonly fail = false) {}

  prepare(query: string) {
    const database = this; let bindings: unknown[] = [];
    const statement = {
      query,
      bind(...values: unknown[]) { bindings = values; return statement; },
      get bindings() { return bindings; },
      async first() {
        if (query.includes("FROM files")) return { ...database.file };
        if (query.startsWith("SELECT COUNT")) return { count: 2 };
        return null;
      },
      async all() {
        if (query.startsWith("SELECT sl.id source_id")) return { results: [
          { source_id: "location-a", object_kind: "shard", device_id: "node-a", object_id: "file-delete/shard/a" },
          { source_id: "share-a", object_kind: "key-share", device_id: "node-b", object_id: "file-delete/share/a" },
        ] };
        return { results: [] };
      },
      async run() { return { meta: { changes: 1 } }; },
    };
    return statement as unknown as D1PreparedStatement;
  }

  async batch(statements: D1PreparedStatement[]) {
    const recorded = statements as unknown as Array<{ query: string; bindings: unknown[] }>;
    this.batches.push(recorded.map((statement) => ({ query: statement.query, bindings: statement.bindings })));
    if (this.fail) throw new Error("D1 unavailable");
    this.file.deletion_state = "pending";
    return [];
  }
}

describe("durable deletion initiation", () => {
  test("creates every deletion task in the same atomic batch as the deleting transition", async () => {
    const database = new DeletionDatabase(); const env: Env = { DB: database as unknown as D1Database, JWT_SECRET: "test-secret-that-is-long-and-random", WEB_ORIGIN: "http://localhost:5173" };
    const token = await issueAccessToken("user-a", "owner@example.com", env.JWT_SECRET);
    const response = await app.request("http://api/files/file-delete", { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }, env);
    expect(response.status).toBe(202);
    expect(database.file.deletion_state).toBe("pending");
    const batch = database.batches[0]!;
    expect(batch).toHaveLength(3);
    expect(batch[0]!.query).toStartWith("UPDATE files SET deletion_state='pending'");
    expect(batch.slice(1).every((statement) => statement.query.startsWith("INSERT INTO file_deletion_tasks"))).toBeTrue();
  });

  test("does not expose a deleting state when atomic task creation fails", async () => {
    const database = new DeletionDatabase(true); const env: Env = { DB: database as unknown as D1Database, JWT_SECRET: "test-secret-that-is-long-and-random", WEB_ORIGIN: "http://localhost:5173" };
    const token = await issueAccessToken("user-a", "owner@example.com", env.JWT_SECRET);
    const response = await app.request("http://api/files/file-delete", { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }, env);
    expect(response.status).toBe(503);
    expect(database.file.deletion_state).toBeNull();
  });
});
