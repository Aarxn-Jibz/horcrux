import { afterEach, describe, expect, test } from "bun:test";
import { authenticatedRequest, login } from "./api";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("API refresh coordination", () => {
  test("uses one refresh for simultaneous expired requests", async () => {
    let refreshes = 0;
    globalThis.fetch = (async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/auth/challenge") return Response.json({ kdf: { version: "pbkdf2-sha256-v1", iterations: 310000, salt: "AAAAAAAAAAAAAAAAAAAAAA==" } });
      if (path === "/auth/login") return Response.json({ accessToken: "old", user: { id: "user-a", email: "a@example.com" } });
      if (path === "/auth/refresh") { refreshes++; await new Promise((resolve) => setTimeout(resolve, 5)); return Response.json({ accessToken: "new", user: { id: "user-a", email: "a@example.com" } }); }
      if (new Headers(init?.headers).get("Authorization") === "Bearer old") return new Response("", { status: 401 });
      return Response.json({ ok: true });
    }) as typeof fetch;
    await login("a@example.com", "password");
    await Promise.all([authenticatedRequest("/files"), authenticatedRequest("/devices")]);
    expect(refreshes).toBe(1);
  });

  test("clears the access token when refresh fails", async () => {
    const authorizations: Array<string | null> = [];
    globalThis.fetch = (async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/auth/challenge") return Response.json({ kdf: { version: "pbkdf2-sha256-v1", iterations: 310000, salt: "AAAAAAAAAAAAAAAAAAAAAA==" } });
      if (path === "/auth/login") return Response.json({ accessToken: "old", user: { id: "user-a", email: "a@example.com" } });
      if (path === "/auth/refresh") return new Response("", { status: 401 });
      authorizations.push(new Headers(init?.headers).get("Authorization"));
      return new Response("", { status: 401 });
    }) as typeof fetch;
    await login("a@example.com", "password");
    await expect(authenticatedRequest("/files")).rejects.toThrow();
    await expect(authenticatedRequest("/files")).rejects.toThrow();
    expect(authorizations).toEqual(["Bearer old", null]);
  });
});
