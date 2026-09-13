import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./env";
import type { ApiVariables } from "./middleware/auth";
import { ApiError, errorResponse } from "./lib/http";
import authRoutes from "./routes/auth";
import fileRoutes from "./routes/files";
import deviceRoutes from "./routes/devices";
import nodeRoutes from "./routes/nodes";

const app = new Hono<{ Bindings: Env; Variables: ApiVariables }>();
app.use("*", async (c, next) => {
  const origin = c.req.header("Origin");
  const changesState = !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
  if (changesState && origin && origin !== c.env.WEB_ORIGIN) {
    throw new ApiError(403, "origin_forbidden", "Request origin is not allowed");
  }
  await next();
});
app.use("*", cors({ origin: (origin, c) => origin === c.env.WEB_ORIGIN ? origin : c.env.WEB_ORIGIN, credentials: true }));
app.get("/health", (c) => c.json({ ok: true }));
app.route("/auth", authRoutes);
app.route("/files", fileRoutes);
app.route("/devices", deviceRoutes);
app.route("/nodes", nodeRoutes);
app.notFound((c) => c.json({ error: { code: "not_found", message: "Route not found" } }, 404));
app.onError((error, c) => errorResponse(c, error));

export default app;
