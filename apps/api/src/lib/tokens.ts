import { sign, verify } from "hono/jwt";

export interface AccessClaims { sub: string; email: string; type: "access"; iss: "horcrux-file-system"; iat: number; exp: number }
const encoder = new TextEncoder();
export async function issueAccessToken(userId: string, email: string, secret: string) { const now = Math.floor(Date.now() / 1000); return sign({ sub: userId, email, type: "access", iss: "horcrux-file-system", iat: now, exp: now + 15 * 60 }, secret, "HS256"); }
export async function readAccessToken(token: string, secret: string) { const claims = await verify(token, secret, "HS256") as unknown as AccessClaims; if (claims.type !== "access" || claims.iss !== "horcrux-file-system" || !claims.sub) throw new Error("Invalid access token"); return claims; }
export function createRefreshToken() { const bytes = crypto.getRandomValues(new Uint8Array(32)); return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""); }
export async function hashToken(token: string) { const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token)); return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""); }

