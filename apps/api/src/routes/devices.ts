import { Hono } from "hono";
import type { Env } from "../env";
import type { ApiVariables } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";
import { createOpaqueToken, hashOpaqueToken } from "../lib/node-crypto";

type DeviceRow = {
  id: string;
  public_identifier: string;
  name: string;
  status: "online" | "offline" | "degraded" | "disabled";
  storage_capacity: number;
  storage_used: number;
  available_storage: number;
  last_seen: string | null;
  node_version: string | null;
  protocol_version: string | null;
  health: "healthy" | "degraded" | "unknown";
  public_key: string | null;
};

const router = new Hono<{ Bindings: Env; Variables: ApiVariables }>();
router.use("*", requireAuth);

router.get("/", async (c) => {
  const rows = await c.env.DB.prepare("SELECT id,public_identifier,name,status,storage_capacity,storage_used,available_storage,last_seen,node_version,protocol_version,health,public_key FROM devices WHERE owner_user_id=? OR owner_user_id IS NULL ORDER BY name").bind(c.get("user").id).all<DeviceRow>();
  return c.json({ devices: rows.results.map((row) => {
    const heartbeatTime = row.last_seen ? Date.parse(`${row.last_seen.replace(" ", "T")}Z`) : 0;
    const stale = Boolean(row.public_key) && (heartbeatTime === 0 || heartbeatTime < Date.now() - 2 * 60_000);
    return {
      id: row.id,
      publicIdentifier: row.public_identifier,
      name: row.name,
      status: stale ? "offline" as const : row.status,
      storageCapacity: row.storage_capacity,
      storageUsed: row.storage_used,
      availableStorage: row.available_storage,
      lastSeen: row.last_seen,
      nodeVersion: row.node_version,
      protocolVersion: row.protocol_version,
      health: stale ? "unknown" as const : row.health,
      kind: row.public_key ? "laptop" as const : "browser-mock" as const,
    };
  }) });
});

router.post("/enrollment-challenges", async (c) => {
  const token = createOpaqueToken();
  const challengeId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  await c.env.DB.prepare("INSERT INTO device_enrollment_challenges (id,user_id,token_hash,expires_at) VALUES (?,?,?,?)").bind(challengeId, c.get("user").id, await hashOpaqueToken(token), expiresAt).run();
  return c.json({ challengeId, token, expiresAt }, 201);
});

export default router;
