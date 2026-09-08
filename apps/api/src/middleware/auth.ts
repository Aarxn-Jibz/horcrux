import { createMiddleware } from "hono/factory";
import type { Env } from "../env";
import { ApiError } from "../lib/http";
import { readAccessToken } from "../lib/tokens";

export interface AuthUser { id: string; email: string }
export type ApiVariables = { user: AuthUser };
export const requireAuth = createMiddleware<{ Bindings: Env; Variables: ApiVariables }>(async (c, next) => { const authorization = c.req.header("Authorization"); if (!authorization?.startsWith("Bearer ")) throw new ApiError(401, "authentication_required", "A valid access token is required"); try { const claims = await readAccessToken(authorization.slice(7), c.env.JWT_SECRET); c.set("user", { id: claims.sub, email: claims.email }); await next(); } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(401, "invalid_token", "The access token is invalid or expired"); } });

