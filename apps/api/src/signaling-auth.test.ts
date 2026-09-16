import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { encodeBase64Url, signEnvelope, webRtcNodeAuthSchema } from "@horcrux-file-system/protocol";
import app from "./index";
import type { Env } from "./env";

class TestD1 {
  constructor(readonly sqlite = new Database(":memory:")) {}
  prepare(query: string) { const database = this.sqlite; let bindings: unknown[] = []; const statement = { query, bind(...values: unknown[]) { bindings = values; return statement; }, get bindings() { return bindings; }, async first<T>() { return (database.query(query).get(bindings as never) ?? null) as T | null; }, async all<T>() { return { results: database.query(query).all(bindings as never) as T[] }; }, async run() { const result = database.query(query).run(bindings as never); return { meta: { changes: Number(result.changes) } }; } }; return statement as unknown as D1PreparedStatement; }
  async batch(statements: D1PreparedStatement[]) { return this.sqlite.transaction(() => (statements as unknown as Array<{ query: string; bindings: unknown[] }>).map((statement) => ({ meta: { changes: Number(this.sqlite.query(statement.query).run(statement.bindings as never).changes) } as D1Result["meta"] } as D1Result)))(); }
}

async function fixture() {
  const db = new TestD1();
  for (const name of ["0001_initial.sql", "0002_storage_nodes.sql", "0003_node_endpoints.sql", "0004_chunked_format.sql", "0005_webrtc_signaling.sql", "0006_durable_file_deletion.sql", "0007_refresh_rotation.sql"]) db.sqlite.exec(await Bun.file(`${import.meta.dir}/../migrations/${name}`).text());
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const privateKey = encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))); const publicKey = encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
  db.sqlite.run("INSERT INTO users (id,email,password_hash) VALUES ('user-a','a@example.com','hash')");
  db.sqlite.run("INSERT INTO devices (id,owner_user_id,public_identifier,name,status,storage_capacity,storage_used,available_storage,public_key,protocol_version,health,endpoint) VALUES ('node-a','user-a','node://a','A','online',100,0,100,?,'1','healthy','http://localhost:9001')", [publicKey]);
  return { db, privateKey, env: { DB: db as unknown as D1Database, JWT_SECRET: "test-secret-that-is-long-and-random", WEB_ORIGIN: "http://localhost:5173" } as Env };
}

function session(db: TestD1, expiresAt: string) { const id = crypto.randomUUID(); db.sqlite.run("INSERT INTO webrtc_sessions (id,user_id,device_id,expires_at) VALUES (?, 'user-a', 'node-a', ?)", [id, expiresAt]); return id; }
async function auth(privateKey: string, sessionId: string, signal?: { type: "answer" | "ice-candidate"; payload: string }, timestamp = Math.floor(Date.now() / 1_000)) {
  const hash = signal ? await digest(signal.payload) : undefined;
  return signEnvelope(webRtcNodeAuthSchema.parse({ version: "1", nodeId: "node-a", operation: "signals", sessionId, ...(signal ? { signalType: signal.type, signalHash: hash } : {}), timestamp }), privateKey);
}
async function digest(value: string) { const bytes = new TextEncoder().encode(value); const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)); return [...hash].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
function exchange(env: Env, auth: string, sessionId: string, signal?: { type: "answer" | "ice-candidate"; payload: string }) { return app.request("http://api/nodes/node-a/webrtc/signals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ auth, sessionId, ...(signal ? { signal } : {}) }) }, env); }

describe("node signaling authentication", () => {
  test("uses chronological ISO expiry comparisons", async () => {
    const { db, privateKey, env } = await fixture(); const signal = { type: "answer" as const, payload: "sdp" };
    const valid = session(db, new Date(Date.now() + 1_000).toISOString());
    expect((await exchange(env, await auth(privateKey, valid, signal), valid, signal)).status).toBe(200);
    const sameDayExpired = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
    const expired = session(db, sameDayExpired);
    expect((await exchange(env, await auth(privateKey, expired, signal), expired, signal)).status).toBe(404);
  });

  test("binds proofs to session, operation, and exact signal", async () => {
    const { db, privateKey, env } = await fixture(); const first = session(db, new Date(Date.now() + 60_000).toISOString()); const second = session(db, new Date(Date.now() + 60_000).toISOString()); const signal = { type: "answer" as const, payload: "sdp-a" }; const proof = await auth(privateKey, first, signal);
    expect((await exchange(env, proof, first, signal)).status).toBe(200);
    expect((await exchange(env, proof, second, signal)).status).toBe(403);
    expect((await exchange(env, proof, first, { ...signal, payload: "sdp-b" })).status).toBe(403);
    expect((await app.request("http://api/nodes/node-a/webrtc/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ auth: proof }) }, env)).status).toBe(403);
    expect((await exchange(env, `${proof}x`, first, signal)).status).toBe(401);
    expect((await exchange(env, await auth(privateKey, first, signal, Math.floor(Date.now() / 1_000) - 121), first, signal)).status).toBe(403);
  });
});
