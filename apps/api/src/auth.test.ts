import { describe, expect, test } from "bun:test";
import app from "./index";
import { hashPassword, verifyPassword } from "./lib/password";
import { issueAccessToken } from "./lib/tokens";

const env = { JWT_SECRET: "test-secret-that-is-long-and-random", WEB_ORIGIN: "http://localhost:5173", DB: {} as D1Database };

describe("authentication", () => {
  test("hashes passwords with salt", async () => {
    const first = await hashPassword("a sufficiently long password"); const second = await hashPassword("a sufficiently long password");
    expect(first).not.toBe(second); expect(await verifyPassword("a sufficiently long password", first)).toBeTrue(); expect(await verifyPassword("wrong password", first)).toBeFalse();
  });

  test("auth middleware accepts a valid access JWT", async () => {
    const token = await issueAccessToken("user-1", "owner@example.com", env.JWT_SECRET);
    const response = await app.request("http://api/auth/me", { headers: { Authorization: `Bearer ${token}` } }, env);
    expect(response.status).toBe(200); expect(await response.json() as unknown).toEqual({ user: { id: "user-1", email: "owner@example.com" } });
  });

  test("auth middleware rejects missing and invalid JWTs", async () => {
    expect((await app.request("http://api/auth/me", {}, env)).status).toBe(401);
    expect((await app.request("http://api/auth/me", { headers: { Authorization: "Bearer nonsense" } }, env)).status).toBe(401);
  });
});
