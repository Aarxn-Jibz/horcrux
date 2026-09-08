import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { credentialsSchema } from "@ciphermesh/shared";
import type { Env } from "../env";
import type { ApiVariables } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";
import { ApiError } from "../lib/http";
import { hashPassword, verifyPassword } from "../lib/password";
import { createRefreshToken, hashToken, issueAccessToken } from "../lib/tokens";

const REFRESH_COOKIE = "ciphermesh_refresh";
type UserRow = { id: string; email: string; password_hash: string };
type RefreshRow = { id: string; user_id: string; email: string; expires_at: string; revoked_at: string | null };
const router = new Hono<{ Bindings: Env; Variables: ApiVariables }>();

function cookieOptions(c: Parameters<typeof setCookie>[0]) { return { httpOnly: true, secure: new URL(c.req.url).protocol === "https:", sameSite: "Lax" as const, path: "/auth", maxAge: 30 * 24 * 60 * 60 }; }
async function setSession(c: Parameters<typeof setCookie>[0], user: { id: string; email: string }, replacedTokenId?: string) { const refresh = createRefreshToken(); const id = crypto.randomUUID(); const expiresAt = new Date(Date.now() + 30 * 86400_000).toISOString(); const hash = await hashToken(refresh); const statements = [c.env.DB.prepare("INSERT INTO refresh_tokens (id,user_id,token_hash,expires_at) VALUES (?,?,?,?)").bind(id, user.id, hash, expiresAt)]; if (replacedTokenId) statements.push(c.env.DB.prepare("UPDATE refresh_tokens SET revoked_at=datetime('now'), replaced_by_token_id=? WHERE id=? AND revoked_at IS NULL").bind(id, replacedTokenId)); await c.env.DB.batch(statements); setCookie(c, REFRESH_COOKIE, refresh, cookieOptions(c)); return { accessToken: await issueAccessToken(user.id, user.email, c.env.JWT_SECRET), user }; }

router.post("/register", async (c) => { const parsed = credentialsSchema.safeParse(await c.req.json().catch(() => null)); if (!parsed.success) throw new ApiError(422, "validation_error", parsed.error.issues[0]?.message ?? "Invalid registration"); const exists = await c.env.DB.prepare("SELECT id FROM users WHERE email=?").bind(parsed.data.email).first(); if (exists) throw new ApiError(409, "email_exists", "An account with this email already exists"); const user = { id: crypto.randomUUID(), email: parsed.data.email }; await c.env.DB.prepare("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)").bind(user.id, user.email, await hashPassword(parsed.data.password)).run(); return c.json(await setSession(c, user), 201); });
router.post("/login", async (c) => { const parsed = credentialsSchema.safeParse(await c.req.json().catch(() => null)); if (!parsed.success) throw new ApiError(401, "invalid_credentials", "Email or password is incorrect"); const user = await c.env.DB.prepare("SELECT id,email,password_hash FROM users WHERE email=?").bind(parsed.data.email).first<UserRow>(); if (!user || !await verifyPassword(parsed.data.password, user.password_hash)) throw new ApiError(401, "invalid_credentials", "Email or password is incorrect"); return c.json(await setSession(c, { id: user.id, email: user.email })); });
router.post("/refresh", async (c) => { const token = getCookie(c, REFRESH_COOKIE); if (!token) throw new ApiError(401, "refresh_required", "Refresh session is missing"); const row = await c.env.DB.prepare("SELECT rt.id,rt.user_id,u.email,rt.expires_at,rt.revoked_at FROM refresh_tokens rt JOIN users u ON u.id=rt.user_id WHERE rt.token_hash=?").bind(await hashToken(token)).first<RefreshRow>(); if (!row || row.revoked_at || Date.parse(row.expires_at) <= Date.now()) { deleteCookie(c, REFRESH_COOKIE, { path: "/auth" }); throw new ApiError(401, "invalid_refresh", "Refresh session is invalid or expired"); } return c.json(await setSession(c, { id: row.user_id, email: row.email }, row.id)); });
router.post("/logout", async (c) => { const token = getCookie(c, REFRESH_COOKIE); if (token) await c.env.DB.prepare("UPDATE refresh_tokens SET revoked_at=datetime('now') WHERE token_hash=? AND revoked_at IS NULL").bind(await hashToken(token)).run(); deleteCookie(c, REFRESH_COOKIE, { path: "/auth" }); return c.body(null, 204); });
router.get("/me", requireAuth, (c) => c.json({ user: c.get("user") }));

export default router;
