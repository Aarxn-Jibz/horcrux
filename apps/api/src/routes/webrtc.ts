import { Hono } from "hono";
import { z } from "zod";
import { webRtcSignalSchema } from "@horcrux-file-system/protocol";
import type { Env } from "../env";
import type { ApiVariables } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";
import { ApiError } from "../lib/http";

const router = new Hono<{ Bindings: Env; Variables: ApiVariables }>();
router.use("*", requireAuth);

router.post("/sessions", async (c) => {
  const body = z.object({ nodeId: z.string().min(1).max(128) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) throw new ApiError(422, "validation_error", "A storage node is required");
  const user = c.get("user");
  const node = await c.env.DB.prepare("SELECT id FROM devices WHERE id=? AND owner_user_id=? AND public_key IS NOT NULL AND endpoint IS NOT NULL").bind(body.data.nodeId, user.id).first();
  if (!node) throw new ApiError(404, "node_not_found", "WebRTC node is unavailable");
  const id = crypto.randomUUID(); const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  await c.env.DB.prepare("INSERT INTO webrtc_sessions (id,user_id,device_id,expires_at) VALUES (?,?,?,?)").bind(id, user.id, body.data.nodeId, expiresAt).run();
  return c.json({ sessionId: id, expiresAt }, 201);
});

router.post("/sessions/:id/signals", async (c) => {
  const signal = webRtcSignalSchema.safeParse({ ...(await c.req.json().catch(() => null) as object), sessionId: c.req.param("id"), sender: "browser" });
  if (!signal.success) throw new ApiError(422, "validation_error", "Invalid WebRTC signal");
  const session = await c.env.DB.prepare("SELECT device_id FROM webrtc_sessions WHERE id=? AND user_id=? AND expires_at>datetime('now')").bind(signal.data.sessionId, c.get("user").id).first<{ device_id: string }>();
  if (!session || session.device_id !== signal.data.nodeId) throw new ApiError(403, "signal_scope_invalid", "Signal session is not scoped to this node");
  await c.env.DB.prepare("INSERT INTO webrtc_signals (id,session_id,sender,signal_type,payload) VALUES (?,?,?,?,?)").bind(crypto.randomUUID(), signal.data.sessionId, "browser", signal.data.type, signal.data.payload).run();
  return c.json({ accepted: true });
});

router.get("/sessions/:id/signals", async (c) => {
  const session = await c.env.DB.prepare("SELECT device_id FROM webrtc_sessions WHERE id=? AND user_id=? AND expires_at>datetime('now')").bind(c.req.param("id"), c.get("user").id).first<{ device_id: string }>();
  if (!session) throw new ApiError(404, "signal_session_not_found", "WebRTC session is unavailable");
  const signals = await c.env.DB.prepare("SELECT signal_type type,payload FROM webrtc_signals WHERE session_id=? AND sender='node' ORDER BY created_at,id").bind(c.req.param("id")).all<{ type: "answer" | "ice-candidate"; payload: string }>();
  return c.json({ nodeId: session.device_id, signals: signals.results });
});

export default router;
