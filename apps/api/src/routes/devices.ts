import { Hono } from "hono";
import type { Env } from "../env";
import type { ApiVariables } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";

const router = new Hono<{ Bindings: Env; Variables: ApiVariables }>();
router.use("*", requireAuth);
router.get("/", async (c) => { const rows = await c.env.DB.prepare("SELECT id,public_identifier,name,status,storage_capacity,storage_used,last_seen FROM devices WHERE owner_user_id=? OR owner_user_id IS NULL ORDER BY name").bind(c.get("user").id).all<{ id: string; public_identifier: string; name: string; status: "online" | "offline" | "degraded" | "disabled"; storage_capacity: number; storage_used: number; last_seen: string | null }>(); return c.json({ devices: rows.results.map((row) => ({ id: row.id, publicIdentifier: row.public_identifier, name: row.name, status: row.status, storageCapacity: row.storage_capacity, storageUsed: row.storage_used, lastSeen: row.last_seen })) }); });
export default router;
