import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { encodeBase64Url, signEnvelope, storageCapabilitySchema, storageReceiptSchema, verifyEnvelope } from "@horcrux-file-system/protocol";
import app from "./index";
import type { Env } from "./env";
import { issueAccessToken } from "./lib/tokens";

class TestD1 {
  constructor(readonly sqlite = new Database(":memory:")) {}
  prepare(query: string) {
    const database = this.sqlite;
    let bindings: unknown[] = [];
    const statement = {
      query,
      bind(...values: unknown[]) { bindings = values; return statement; },
      get bindings() { return bindings; },
      async first<T>() { return (database.query(query).get(bindings as never) ?? null) as T | null; },
      async all<T>() { return { results: database.query(query).all(bindings as never) as T[] }; },
      async run() { const result = database.query(query).run(bindings as never); return { meta: { changes: Number(result.changes) } }; },
    };
    return statement as unknown as D1PreparedStatement;
  }
  async batch(statements: D1PreparedStatement[]) {
    return this.sqlite.transaction(() => (statements as unknown as Array<{ query: string; bindings: unknown[] }>).map((statement) => {
      const result = this.sqlite.query(statement.query).run(statement.bindings as never);
      return { meta: { changes: Number(result.changes) } } as D1Result;
    }))();
  }
}

type Keys = { privateKey: string; publicKey: string };
const hash = "a".repeat(64);

async function fixture() {
  const db = new TestD1();
  for (const name of ["0001_initial.sql", "0002_storage_nodes.sql", "0003_node_endpoints.sql", "0004_chunked_format.sql", "0005_webrtc_signaling.sql", "0006_durable_file_deletion.sql"]) db.sqlite.exec(await Bun.file(`${import.meta.dir}/../migrations/${name}`).text());
  const control = await keys(); const node = await keys(); const otherNode = await keys();
  db.sqlite.run("INSERT INTO users (id,email,password_hash) VALUES ('user-a','a@example.com','hash'),('user-b','b@example.com','hash')");
  db.sqlite.run("INSERT INTO devices (id,owner_user_id,public_identifier,name,status,storage_capacity,storage_used,available_storage,public_key,protocol_version,health,endpoint) VALUES ('node-a','user-a','node://a','A','online',1000,0,1000,?,'1','healthy','http://localhost:9001'),('node-b','user-b','node://b','B','online',1000,0,1000,?,'1','healthy','http://localhost:9002')", [node.publicKey, otherNode.publicKey]);
  const env = { DB: db as unknown as D1Database, JWT_SECRET: "test-secret-that-is-long-and-random", WEB_ORIGIN: "http://localhost:5173", CAPABILITY_PRIVATE_KEY: control.privateKey } as Env;
  return { db, env, control, node, token: await issueAccessToken("user-a", "a@example.com", env.JWT_SECRET), otherToken: await issueAccessToken("user-b", "b@example.com", env.JWT_SECRET) };
}

function seedUpload(db: TestD1, userId = "user-a", status = "initialized") {
  const fileId = crypto.randomUUID();
  db.sqlite.run("INSERT INTO files (id,owner_user_id,original_name,mime_type,original_size,plaintext_hash,status,rs_data_shards,rs_parity_shards,key_share_threshold,key_share_count,format_version) VALUES (?,?, 'test','text/plain',1,?,'uploading',3,2,3,5,1)", [fileId, userId, hash]);
  db.sqlite.run("INSERT INTO upload_sessions (id,file_id,user_id,status,expires_at) VALUES (?,?,?,?,?)", [crypto.randomUUID(), fileId, userId, status, new Date(Date.now() + 60_000).toISOString()]);
  return fileId;
}

function manifest(fileId: string) {
  return { compressedSize: 1, encryptedSize: 1, ciphertextHash: hash, encryptionIv: "a".repeat(16), shardSize: 1, objects: [
    ...[0, 1, 2].map((index) => ({ id: crypto.randomUUID(), kind: "shard", index, shardType: "data", nodeId: `mock-${String.fromCharCode(97 + index)}`, objectId: `${fileId}/shard/${index}`, size: 1, checksum: hash, status: "stored" })),
    ...[0, 1, 2].map((index) => ({ id: crypto.randomUUID(), kind: "key-share", index, nodeId: `mock-${String.fromCharCode(97 + index)}`, objectId: `${fileId}/key-share/${index}`, size: 1, checksum: hash, status: "stored" })),
  ] };
}

function first(db: TestD1, query: string, bindings: unknown[]) { return db.sqlite.query(query).get(bindings as never); }
function all(db: TestD1, query: string, bindings: unknown[]) { return db.sqlite.query(query).all(bindings as never); }
function request(env: Env, path: string, token: string, body?: unknown, method = "POST") { return app.request(`http://api${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env); }

describe("upload lifecycle recovery", () => {
  test("commits atomically, retries a lost response, and recovers a legacy committing session", async () => {
    const { db, env, token } = await fixture();
    const fileId = seedUpload(db);
    const body = manifest(fileId);
    expect((await request(env, `/files/${fileId}/complete`, token, body)).status).toBe(200);
    // Treat the preceding response as lost: a retry reports the committed file,
    // so the browser does not enter its rollback path.
    expect((await request(env, `/files/${fileId}/complete`, token, body)).status).toBe(200);
    expect(first(db, "SELECT status FROM files WHERE id=?", [fileId])).toEqual({ status: "available" });

    const stranded = seedUpload(db, "user-a", "committing");
    expect((await request(env, `/files/${stranded}/complete`, token, manifest(stranded))).status).toBe(200);
    expect(first(db, "SELECT status FROM upload_sessions WHERE file_id=?", [stranded])).toEqual({ status: "complete" });
  });

  test("pre-commit PUT intents authorize only their own cleanup and abort creates durable work", async () => {
    const { db, env, token, otherToken } = await fixture();
    const fileId = seedUpload(db);
    const objectId = `${fileId}/shard/${crypto.randomUUID()}`; const siblingObjectId = `${fileId}/shard/${crypto.randomUUID()}`;
    // This grant is the durable record that exists before a real node can accept PUT.
    expect((await request(env, "/nodes/node-a/capabilities", token, { fileId, objectId, operation: "PUT", checksum: hash, size: 1 })).status).toBe(201);
    expect((await request(env, "/nodes/node-a/capabilities", token, { fileId, objectId: siblingObjectId, operation: "PUT", checksum: hash, size: 1 })).status).toBe(201);
    expect((await request(env, "/nodes/node-a/capabilities", token, { fileId, objectId, operation: "DELETE" })).status).toBe(201);
    expect((await request(env, "/nodes/node-a/capabilities", token, { fileId, objectId: `${fileId}/shard/not-issued`, operation: "DELETE" })).status).toBe(403);
    expect((await request(env, "/nodes/node-a/capabilities", otherToken, { fileId, objectId, operation: "DELETE" })).status).toBe(404);
    expect((await request(env, `/files/${fileId}/state`, token, { status: "aborted" })).status).toBe(200);
    expect(all(db, "SELECT device_id,object_id,status FROM file_deletion_tasks WHERE file_id=? ORDER BY object_id", [fileId])).toEqual([
      { device_id: "node-a", object_id: [objectId, siblingObjectId].sort()[0], status: "pending" },
      { device_id: "node-a", object_id: [objectId, siblingObjectId].sort()[1], status: "pending" },
    ]);
  });

  test("a stored receipt is idempotent after its response is lost", async () => {
    const { db, env, control, node, token } = await fixture();
    const fileId = seedUpload(db); const objectId = `${fileId}/shard/${crypto.randomUUID()}`;
    const grant = await request(env, "/nodes/node-a/capabilities", token, { fileId, objectId, operation: "PUT", checksum: hash, size: 1 });
    const { capability } = await grant.json() as { capability: string };
    const issued = await verifyEnvelope(capability, control.publicKey, storageCapabilitySchema);
    const receipt = await signEnvelope(storageReceiptSchema.parse({ version: "1", nodeId: "node-a", objectId, checksum: hash, size: 1, timestamp: Math.floor(Date.now() / 1_000), requestId: issued.jti }), node.privateKey);
    expect((await request(env, "/nodes/node-a/receipts", token, { fileId, receipt })).status).toBe(200);
    // The first 200 may have been lost on the wire; the same signed receipt is safe to retry.
    expect((await request(env, "/nodes/node-a/receipts", token, { fileId, receipt })).status).toBe(200);
    expect(first(db, "SELECT COUNT(*) count FROM storage_receipts WHERE request_id=?", [issued.jti])).toEqual({ count: 1 });
  });
});

async function keys(): Promise<Keys> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  return { privateKey: encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))), publicKey: encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))) };
}
