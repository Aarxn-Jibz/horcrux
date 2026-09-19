import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Env } from "../env";
import type { ApiVariables } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";
import { ApiError } from "../lib/http";
import { equal, freshKdf, validKdf, verifier, type Kdf } from "../lib/auth-verifier";
import { createRefreshToken, hashToken, issueAccessToken } from "../lib/tokens";

const REFRESH_COOKIE = "horcrux_file_system_refresh";
type UserRow = { id: string; email: string; auth_kdf_version: string | null; auth_kdf_salt: string | null; auth_kdf_iterations: number | null; auth_verifier: string | null };
type RefreshRow = { id: string; user_id: string; email: string; expires_at: string; revoked_at: string | null };
const router = new Hono<{ Bindings: Env; Variables: ApiVariables }>();

export function refreshCookieOptions(requestUrl: string) {
  const secure = new URL(requestUrl).protocol === "https:";
  return {
    httpOnly: true,
    secure,
    sameSite: secure ? "None" as const : "Lax" as const,
    path: "/auth",
    maxAge: 30 * 24 * 60 * 60,
    ...(secure ? { partitioned: true as const } : {}),
  };
}
function cookieOptions(c: Parameters<typeof setCookie>[0]) { return refreshCookieOptions(c.req.url); }
async function setSession(c: Parameters<typeof setCookie>[0], user: { id: string; email: string }) { const refresh = createRefreshToken(); const id = crypto.randomUUID(); const expiresAt = new Date(Date.now() + 30 * 86400_000).toISOString(); const hash = await hashToken(refresh); await c.env.DB.prepare("INSERT INTO refresh_tokens (id,user_id,token_hash,expires_at) VALUES (?,?,?,?)").bind(id, user.id, hash, expiresAt).run(); setCookie(c, REFRESH_COOKIE, refresh, cookieOptions(c)); return { accessToken: await issueAccessToken(user.id, user.email, c.env.JWT_SECRET), user }; }
async function rotateSession(c: Parameters<typeof setCookie>[0], row: RefreshRow, tokenHash: string) {
  const refresh = createRefreshToken(); const id = crypto.randomUUID(); const expiresAt = new Date(Date.now() + 30 * 86400_000).toISOString(); const hash = await hashToken(refresh); const rotationId = crypto.randomUUID();
  const results = await c.env.DB.batch([
    c.env.DB.prepare("UPDATE refresh_tokens SET revoked_at=datetime('now'),rotation_id=? WHERE id=? AND token_hash=? AND revoked_at IS NULL AND julianday(expires_at)>julianday('now') AND rotation_id IS NULL").bind(rotationId, row.id, tokenHash),
    c.env.DB.prepare("INSERT INTO refresh_tokens (id,user_id,token_hash,expires_at) SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM refresh_tokens WHERE id=? AND rotation_id=? AND revoked_at IS NOT NULL AND replaced_by_token_id IS NULL)").bind(id, row.user_id, hash, expiresAt, row.id, rotationId),
    c.env.DB.prepare("UPDATE refresh_tokens SET replaced_by_token_id=?,rotation_id=NULL WHERE id=? AND rotation_id=? AND replaced_by_token_id IS NULL").bind(id, row.id, rotationId),
  ]);
  if (!results[0]?.meta.changes) throw new ApiError(401, "refresh_consumed", "Refresh session was already consumed");
  setCookie(c, REFRESH_COOKIE, refresh, cookieOptions(c));
  return { accessToken: await issueAccessToken(row.user_id, row.email, c.env.JWT_SECRET), user: { id: row.user_id, email: row.email } };
}

const email = (value: unknown) => typeof value === "string" && value.trim().length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) ? value.trim().toLowerCase() : null;
const credential = (value: unknown) => typeof value === "string" && value.length >= 40 && value.length <= 512 ? value : null;
const unavailable = () => new ApiError(503, "auth_unavailable", "Authentication is temporarily unavailable");
router.post("/challenge", async (c) => { const input = await c.req.json().catch(() => null) as { email?: unknown } | null; const address = email(input?.email); const fake = freshKdf(); if (!address) return c.json({ kdf: fake }); const user = await c.env.DB.prepare("SELECT auth_kdf_version,auth_kdf_salt,auth_kdf_iterations FROM users WHERE email=?").bind(address).first<Pick<UserRow, "auth_kdf_version" | "auth_kdf_salt" | "auth_kdf_iterations">>(); const kdf: Kdf = user && validKdf({ version: user.auth_kdf_version, salt: user.auth_kdf_salt, iterations: user.auth_kdf_iterations }) ? { version: user.auth_kdf_version!, salt: user.auth_kdf_salt!, iterations: user.auth_kdf_iterations! } : fake; return c.json({ kdf }); });
router.post("/register", async (c) => { const input = await c.req.json().catch(() => null) as { email?: unknown; credential?: unknown; kdf?: unknown } | null; const address = email(input?.email); const proof = credential(input?.credential); if (!address || !proof || !validKdf(input?.kdf)) throw new ApiError(422, "validation_error", "Invalid registration"); if (!c.env.AUTH_PEPPER) throw unavailable(); const exists = await c.env.DB.prepare("SELECT id FROM users WHERE email=?").bind(address).first(); if (exists) throw new ApiError(409, "email_exists", "An account with this email already exists"); const user = { id: crypto.randomUUID(), email: address }; await c.env.DB.prepare("INSERT INTO users (id,email,password_hash,auth_kdf_version,auth_kdf_salt,auth_kdf_iterations,auth_verifier) VALUES (?,?,?,?,?,?,?)").bind(user.id, user.email, "client-kdf", input.kdf.version, input.kdf.salt, input.kdf.iterations, await verifier(proof, c.env.AUTH_PEPPER)).run(); return c.json(await setSession(c, user), 201); });
router.post("/login", async (c) => { const input = await c.req.json().catch(() => null) as { email?: unknown; credential?: unknown } | null; const address = email(input?.email); const proof = credential(input?.credential); if (!address || !proof) throw new ApiError(401, "invalid_credentials", "Email or password is incorrect"); if (!c.env.AUTH_PEPPER) throw unavailable(); const user = await c.env.DB.prepare("SELECT id,email,auth_kdf_version,auth_kdf_salt,auth_kdf_iterations,auth_verifier FROM users WHERE email=?").bind(address).first<UserRow>(); if (!user?.auth_verifier || !equal(await verifier(proof, c.env.AUTH_PEPPER), user.auth_verifier)) throw new ApiError(401, "invalid_credentials", "Email or password is incorrect"); return c.json(await setSession(c, { id: user.id, email: user.email })); });
router.post("/refresh", async (c) => { const token = getCookie(c, REFRESH_COOKIE); if (!token) throw new ApiError(401, "refresh_required", "Refresh session is missing"); const tokenHash = await hashToken(token); const row = await c.env.DB.prepare("SELECT rt.id,rt.user_id,u.email,rt.expires_at,rt.revoked_at FROM refresh_tokens rt JOIN users u ON u.id=rt.user_id WHERE rt.token_hash=?").bind(tokenHash).first<RefreshRow>(); if (!row || row.revoked_at || Date.parse(row.expires_at) <= Date.now()) { deleteCookie(c, REFRESH_COOKIE, cookieOptions(c)); throw new ApiError(401, "invalid_refresh", "Refresh session is invalid or expired"); } return c.json(await rotateSession(c, row, tokenHash)); });
router.post("/logout", async (c) => { const token = getCookie(c, REFRESH_COOKIE); if (token) { const tokenHash = await hashToken(token); await c.env.DB.prepare("UPDATE refresh_tokens SET revoked_at=datetime('now') WHERE revoked_at IS NULL AND (token_hash=? OR id=(SELECT replaced_by_token_id FROM refresh_tokens WHERE token_hash=?))").bind(tokenHash, tokenHash).run(); } deleteCookie(c, REFRESH_COOKIE, cookieOptions(c)); return c.body(null, 204); });
router.get("/me", requireAuth, (c) => c.json({ user: c.get("user") }));

export default router;
