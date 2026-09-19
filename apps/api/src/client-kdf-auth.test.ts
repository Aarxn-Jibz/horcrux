import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import app from "./index";
import type { Env } from "./env";
import { freshKdf } from "./lib/auth-verifier";

class TestD1 {
  sqlite = new Database(":memory:");
  prepare(query: string) { const sqlite = this.sqlite; let bindings: unknown[] = []; const statement = { bind(...values: unknown[]) { bindings = values; return statement; }, async first<T>() { return (sqlite.query(query).get(bindings as never) as T | null) ?? null; }, async run() { const result = sqlite.query(query).run(bindings as never); return { meta: { changes: Number(result.changes) } } as D1Result; } }; return statement as unknown as D1PreparedStatement; }
  async batch(statements: D1PreparedStatement[]) { return (statements as unknown as Array<{ query: string; bindings: unknown[] }>).map((statement) => ({ meta: { changes: Number(this.sqlite.query(statement.query).run(statement.bindings as never).changes) } } as D1Result)); }
}
async function fixture() { const db = new TestD1(); for (const migration of ["0001_initial.sql", "0007_refresh_rotation.sql", "0009_client_kdf_auth.sql"]) db.sqlite.exec(await Bun.file(`${import.meta.dir}/../migrations/${migration}`).text()); return { db, env: { DB: db as unknown as D1Database, JWT_SECRET: "test-secret-that-is-long-and-random", AUTH_PEPPER: "test-auth-pepper", WEB_ORIGIN: "http://localhost:5173" } as Env }; }
const credential = "derived-browser-credential-012345678901234567890123456789";
const request = (path: string, body: unknown, env: Env) => app.request(`http://api/auth${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, env);

test("client-derived registration and login persist only a peppered verifier", async () => {
  const { db, env } = await fixture(); const kdf = freshKdf();
  const registered = await request("/register", { email: "user@example.com", credential, kdf }, env);
  expect(registered.status).toBe(201);
  const row = db.sqlite.query("SELECT password_hash,auth_kdf_version,auth_kdf_salt,auth_kdf_iterations,auth_verifier FROM users WHERE email='user@example.com'").get() as Record<string, unknown>;
  expect(row.password_hash).toBe("client-kdf"); expect(row.auth_kdf_version).toBe(kdf.version); expect(row.auth_kdf_salt).toBe(kdf.salt); expect(row.auth_kdf_iterations).toBe(kdf.iterations); expect(row.auth_verifier).not.toBe(credential);
  expect((await request("/login", { email: "user@example.com", credential }, env)).status).toBe(200);
  expect((await request("/login", { email: "user@example.com", credential: `${credential}x` }, env)).status).toBe(401);
});

test("unknown login challenges use indistinguishable fake KDF data", async () => {
  const { env } = await fixture();
  const first = await request("/challenge", { email: "missing@example.com" }, env); const second = await request("/challenge", { email: "missing@example.com" }, env);
  expect(first.status).toBe(200); expect(second.status).toBe(200);
  const one = await first.json() as { kdf: ReturnType<typeof freshKdf> }; const two = await second.json() as { kdf: ReturnType<typeof freshKdf> };
  expect(one.kdf.version).toBe(two.kdf.version); expect(one.kdf.iterations).toBe(two.kdf.iterations); expect(one.kdf.salt).not.toBe(two.kdf.salt);
});
