import type { Context } from "hono";

export class ApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 500 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function errorResponse(c: Context, error: unknown) {
  if (error instanceof ApiError) {
    return c.json({ error: { code: error.code, message: error.message } }, error.status);
  }
  console.error("Unhandled API error", error instanceof Error ? error.message : "unknown");
  return c.json({ error: { code: "internal_error", message: "An internal error occurred" } }, 500);
}
