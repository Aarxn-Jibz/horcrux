import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import app from "./index";
import type { Env } from "./env";
import { freshKdf } from "./lib/auth-verifier";
import { deriveCredential } from "../../web/src/lib/auth-credential";

class TestD1 {
  sqlite = new Database(":memory:");
  prepare(query: string) { const sqlite = this.sqlite; let bindings: unknown[] = []; const statement = { bind(...values: unknown[]) { bindings = values; return statement; }, async first<T>() { return (sqlite.query(query).get(bindings as never) as T | null) ?? null; }, async run() { const result = sqlite.query(query).run(bindings as never); return { meta: { changes: Number(result.changes) } } as D1Result; } }; return statement as unknown as D1PreparedStatement; }
  async batch(statements: D1PreparedStatement[]) { return (statements as unknown as Array<{ query: string; bindings: unknown[] }>).map((statement) => ({ meta: { changes: Number(this.sqlite.query(statement.query).run(statement.bindings as never).changes) } } as D1Result)); }
}
async function fixture() { const db = new TestD1(); for (const migration of ["0001_initial.sql", "0007_refresh_rotation.sql", "0009_client_kdf_auth.sql", "0010_auth_throttle.sql"]) db.sqlite.exec(await Bun.file(`${import.meta.dir}/../migrations/${migration}`).text()); return { db, env: { DB: db as unknown as D1Database, JWT_SECRET: "test-secret-that-is-long-and-random", AUTH_PEPPER: "test-auth-pepper", WEB_ORIGIN: "http://localhost:5173" } as Env }; }
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
  const { db, env } = await fixture(); const registeredKdf = freshKdf();
  await request("/register", { email: "present@example.com", credential, kdf: registeredKdf }, env);
  const first = await request("/challenge", { email: "missing@example.com" }, env); const second = await request("/challenge", { email: "missing@example.com" }, env);
  expect(first.status).toBe(200); expect(second.status).toBe(200);
  const one = await first.json() as { kdf: ReturnType<typeof freshKdf> }; const two = await second.json() as { kdf: ReturnType<typeof freshKdf> };
  expect(one.kdf).toEqual(two.kdf); expect(one.kdf.salt).toHaveLength(24);
  const other = await (await request("/challenge", { email: "other@example.com" }, env)).json() as { kdf: ReturnType<typeof freshKdf> };
  const present = await (await request("/challenge", { email: "present@example.com" }, env)).json() as { kdf: ReturnType<typeof freshKdf> };
  expect(other.kdf.salt).not.toBe(one.kdf.salt); expect(Object.keys(present.kdf).sort()).toEqual(Object.keys(one.kdf).sort()); expect(db.sqlite.query("SELECT count(*) AS count FROM users").get() as { count: number }).toEqual({ count: 1 });
});

test("challenge converts a valid legacy hash into a peppered verifier", async () => {
  const { db, env } = await fixture(); const salt = "AAAAAAAAAAAAAAAAAAAAAA=="; const output = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  db.sqlite.run("INSERT INTO users (id,email,password_hash) VALUES ('legacy','legacy@example.com',?)", [`pbkdf2-sha256$310000$${salt}$${output}`]);
  const challenge = await request("/challenge", { email: "legacy@example.com" }, env); expect(challenge.status).toBe(200);
  const row = db.sqlite.query("SELECT password_hash,auth_kdf_salt,auth_verifier FROM users WHERE id='legacy'").get() as Record<string, string>;
  expect(row.password_hash).toBe("client-kdf"); expect(row.auth_kdf_salt).toBe(salt); expect(row.auth_verifier).not.toBe(output);
});

test("malformed legacy hashes fail closed and duplicate registration is generic", async () => {
  const { db, env } = await fixture(); const kdf = freshKdf();
  db.sqlite.run("INSERT INTO users (id,email,password_hash) VALUES ('bad','bad@example.com','pbkdf2-sha256$1$bad$bad')");
  const challenge = await request("/challenge", { email: "bad@example.com" }, env);
  expect(challenge.status).toBe(200); expect((db.sqlite.query("SELECT password_hash FROM users WHERE id='bad'").get() as { password_hash: string }).password_hash).toContain("$1$");
  const registrations = await Promise.all([request("/register", { email: "race@example.com", credential, kdf }, env), request("/register", { email: "race@example.com", credential, kdf }, env)]);
  expect(registrations.map((response) => response.status).sort()).toEqual([201, 409]);
  expect(db.sqlite.query("SELECT count(*) AS count FROM users WHERE email='race@example.com'").get()).toEqual({ count: 1 });
});

test("login failures throttle and a successful login clears prior failures", async () => {
  const { db, env } = await fixture(); const kdf = freshKdf();
  await request("/register", { email: "limit@example.com", credential, kdf }, env);
  await request("/login", { email: "limit@example.com", credential: `${credential}x` }, env);
  expect((await request("/login", { email: "limit@example.com", credential }, env)).status).toBe(200);
  expect(db.sqlite.query("SELECT count(*) AS count FROM auth_login_attempts").get()).toEqual({ count: 0 });
  for (let attempt = 0; attempt < 5; attempt++) expect((await request("/login", { email: "limit@example.com", credential: `${credential}x` }, env)).status).toBe(401);
  expect((await request("/login", { email: "limit@example.com", credential }, env)).status).toBe(401);
});

test("same password produces distinct credentials and verifiers with unique salts", async () => {
  const { db, env } = await fixture(); const first = freshKdf(); const second = freshKdf();
  const firstCredential = await deriveCredential("same-password", first); const secondCredential = await deriveCredential("same-password", second);
  expect(firstCredential).not.toBe(secondCredential);
  await request("/register", { email: "first@example.com", credential: firstCredential, kdf: first }, env); await request("/register", { email: "second@example.com", credential: secondCredential, kdf: second }, env);
  const rows = db.sqlite.query("SELECT auth_kdf_salt,auth_verifier FROM users WHERE email IN ('first@example.com','second@example.com') ORDER BY email").all() as Array<{ auth_kdf_salt: string; auth_verifier: string }>;
  expect(rows).toHaveLength(2); expect(rows[0]!.auth_kdf_salt).not.toBe(rows[1]!.auth_kdf_salt); expect(rows[0]!.auth_verifier).not.toBe(rows[1]!.auth_verifier);
});
