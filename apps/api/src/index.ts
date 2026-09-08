import { Hono } from "hono";
import { cors } from "hono/cors";

export interface Env { DB: D1Database; JWT_SECRET: string; WEB_ORIGIN: string }
const app = new Hono<{ Bindings: Env }>();
app.use("*", cors({ origin: (origin, c) => origin === c.env.WEB_ORIGIN ? origin : c.env.WEB_ORIGIN, credentials: true }));
app.get("/health", (c) => c.json({ ok: true }));

export default app;

