import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import app from "./index";
import type { Env } from "./env";
import { hashToken } from "./lib/tokens";

class TestD1 {
  constructor(readonly sqlite = new Database(":memory:")) {}
  prepare(query: string) {
    const database = this.sqlite; let bindings: unknown[] = [];
    const statement = { query, bind(...values: unknown[]) { bindings = values; return statement; }, get bindings() { return bindings; }, async first<T>() { return (database.query(query).get(bindings as never) ?? null) as T | null; }, async all<T>() { return { results: database.query(query).all(bindings as never) as T[] }; }, async run() { const result = database.query(query).run(bindings as never); return { meta: { changes: Number(result.changes) } }; } };
    return statement as unknown as D1PreparedStatement;
  }
  async batch(statements: D1PreparedStatement[]) { return this.sqlite.transaction(() => (statements as unknown as Array<{ query: string; bindings: unknown[] }>).map((statement) => { const result = this.sqlite.query(statement.query).run(statement.bindings as never); return { meta: { changes: Number(result.changes) } } as D1Result; }))(); }
}

async function fixture() {
  const db = new TestD1();
  for (const name of ["0001_initial.sql", "0007_refresh_rotation.sql"]) db.sqlite.exec(await Bun.file(`${import.meta.dir}/../migrations/${name}`).text());
  db.sqlite.run("INSERT INTO users (id,email,password_hash) VALUES ('user-a','a@example.com','hash')");
  const token = "predecessor-refresh-token"; const hash = await hashToken(token);
  db.sqlite.run("INSERT INTO refresh_tokens (id,user_id,token_hash,expires_at) VALUES ('predecessor','user-a',?,?)", [hash, new Date(Date.now() + 60_000).toISOString()]);
  return { db, token, env: { DB: db as unknown as D1Database, JWT_SECRET: "test-secret-that-is-long-and-random", WEB_ORIGIN: "http://localhost:5173" } as Env };
}

function refresh(env: Env, token: string) { return app.request("http://api/auth/refresh", { method: "POST", headers: { Cookie: `horcrux_file_system_refresh=${token}` } }, env); }
function cookie(response: Response) { const value = response.headers.get("set-cookie")?.match(/horcrux_file_system_refresh=([^;]+)/)?.[1]; if (!value) throw new Error("missing refresh cookie"); return value; }
function row(db: TestD1, query: string, bindings: unknown[] = []) { return db.sqlite.query(query).get(bindings as never); }

describe("refresh rotation", () => {
  test("claims a predecessor once and creates no losing successor", async () => {
    const { db, env, token } = await fixture();
    const responses = await Promise.all([refresh(env, token), refresh(env, token)]);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 401)).toHaveLength(1);
    expect(row(db, "SELECT COUNT(*) count FROM refresh_tokens WHERE user_id='user-a' AND revoked_at IS NULL")).toEqual({ count: 1 });
    expect(row(db, "SELECT replaced_by_token_id,rotation_id FROM refresh_tokens WHERE id='predecessor'")).toMatchObject({ rotation_id: null });
  });

  test("rotates sequentially, rejects predecessor reuse, and logout revokes a racing successor", async () => {
    const { db, env, token } = await fixture();
    const first = await refresh(env, token); expect(first.status).toBe(200);
    const successor = cookie(first);
    expect((await refresh(env, token)).status).toBe(401);
    expect((await refresh(env, successor)).status).toBe(200);

    const race = await fixture();
    const [rotated, loggedOut] = await Promise.all([
      refresh(race.env, race.token),
      app.request("http://api/auth/logout", { method: "POST", headers: { Cookie: `horcrux_file_system_refresh=${race.token}` } }, race.env),
    ]);
    expect([200, 401]).toContain(rotated.status); expect(loggedOut.status).toBe(204);
    expect(row(race.db, "SELECT COUNT(*) count FROM refresh_tokens WHERE user_id='user-a' AND revoked_at IS NULL")).toEqual({ count: 0 });
    void db;
  });
});
