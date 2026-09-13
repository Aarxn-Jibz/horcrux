import { describe, expect, test } from "bun:test";
import app from "./index";
import { hashPassword, verifyPassword } from "./lib/password";
import { issueAccessToken } from "./lib/tokens";
import { credentialsSchema } from "@horcrux-file-system/shared";
import { refreshCookieOptions } from "./routes/auth";

const env = { JWT_SECRET: "test-secret-that-is-long-and-random", WEB_ORIGIN: "http://localhost:5173", DB: {} as D1Database };

describe("authentication", () => {
  test("accepts eight-character passwords and rejects shorter ones", () => {
    expect(credentialsSchema.safeParse({ email: "user@example.com", password: "12345678" }).success).toBeTrue();
    expect(credentialsSchema.safeParse({ email: "user@example.com", password: "1234567" }).success).toBeFalse();
  });

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

  test("uses a partitioned secure refresh cookie across production origins", () => {
    expect(refreshCookieOptions("https://horcruxfs-api.example.workers.dev/auth/login")).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "None",
      partitioned: true,
      path: "/auth",
    });
    expect(refreshCookieOptions("http://localhost:8787/auth/login")).toMatchObject({
      secure: false,
      sameSite: "Lax",
    });
  });

  test("rejects state-changing requests from another browser origin", async () => {
    const response = await app.request("http://api/auth/logout", {
      method: "POST",
      headers: { Origin: "https://attacker.example" },
    }, env);
    expect(response.status).toBe(403);
    expect(await response.json() as unknown).toEqual({
      error: { code: "origin_forbidden", message: "Request origin is not allowed" },
    });
  });
});
