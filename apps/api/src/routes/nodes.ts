import { Hono } from "hono";
import { z } from "zod";
import {
  heartbeatSchema,
  PROTOCOL_VERSION,
  storageReceiptSchema,
  verifyEnvelope,
  type StorageCapability,
} from "@horcrux-file-system/protocol";
import type { Env } from "../env";
import type { ApiVariables } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";
import { ApiError } from "../lib/http";
import { deriveNodeId, enrollmentProofPayload, hashOpaqueToken, issueCapability, receiptMatchesCapability, verifyNodeSignature } from "../lib/node-crypto";

const enrollmentSchema = z.object({
  challengeId: z.uuid(),
  token: z.string().min(32).max(512),
  publicKey: z.string().min(40).max(128),
  signature: z.string().min(40).max(128),
  name: z.string().trim().min(1).max(128),
  capacityBytes: z.int().positive(),
});

type ChallengeRow = { user_id: string; expires_at: string; used_at: string | null };
type NodeRow = { id: string; public_key: string };
type IssuedRow = { jti: string; device_id: string; object_id: string; operation: "PUT"; checksum: string | null; size: number | null; expires_at: string };
const capabilityRequestSchema = z.object({ fileId: z.uuid(), objectId: z.string().min(1).max(256), operation: z.enum(["PUT", "GET", "DELETE"]), checksum: z.string().regex(/^[a-f0-9]{64}$/).optional(), size: z.int().nonnegative().optional(), maxSize: z.int().positive().optional() }).refine((input) => input.operation !== "PUT" || input.maxSize !== undefined || (input.checksum !== undefined && input.size !== undefined), "PUT capabilities require exact metadata or a maximum size").refine((input) => input.maxSize === undefined || (input.checksum === undefined && input.size === undefined), "streamed PUT final metadata is node-attested");
const router = new Hono<{ Bindings: Env; Variables: ApiVariables }>();

router.post("/enroll", async (c) => {
  const parsed = enrollmentSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ApiError(422, "validation_error", parsed.error.issues[0]?.message ?? "Invalid enrollment proof");
  const input = parsed.data;
  const challenge = await c.env.DB.prepare("SELECT user_id,expires_at,used_at FROM device_enrollment_challenges WHERE id=? AND token_hash=?").bind(input.challengeId, await hashOpaqueToken(input.token)).first<ChallengeRow>();
  if (!challenge || challenge.used_at || Date.parse(challenge.expires_at) <= Date.now()) throw new ApiError(401, "enrollment_invalid", "Enrollment challenge is invalid, used, or expired");
  const proof = enrollmentProofPayload(input.challengeId, input.token, input.publicKey);
  if (!await verifyNodeSignature(input.publicKey, proof, input.signature)) throw new ApiError(401, "enrollment_proof_invalid", "Node did not prove possession of its identity key");
  const nodeId = await deriveNodeId(input.publicKey);
  const claimed = await c.env.DB.prepare("UPDATE device_enrollment_challenges SET used_at=datetime('now') WHERE id=? AND token_hash=? AND used_at IS NULL AND expires_at>datetime('now') RETURNING user_id").bind(input.challengeId, await hashOpaqueToken(input.token)).first<{ user_id: string }>();
  if (!claimed || claimed.user_id !== challenge.user_id) throw new ApiError(401, "enrollment_invalid", "Enrollment challenge was already consumed");
  try {
    await c.env.DB.prepare("INSERT INTO devices (id,owner_user_id,public_identifier,name,status,storage_capacity,storage_used,available_storage,public_key,protocol_version,health) VALUES (?,?,?,?,'offline',?,0,?,?,'1','unknown')").bind(nodeId, challenge.user_id, `node://${nodeId}`, input.name, input.capacityBytes, input.capacityBytes, input.publicKey).run();
  } catch {
    throw new ApiError(409, "node_already_enrolled", "This node identity is already enrolled");
  }
  return c.json({ nodeId, publicKey: input.publicKey, status: "offline" }, 201);
});

router.post("/:id/heartbeat", async (c) => {
  const body = z.object({ heartbeat: z.string().min(80).max(4096) }).safeParse(
    await c.req.json().catch(() => null),
  );
  if (!body.success) throw new ApiError(422, "validation_error", "Invalid heartbeat submission");

  const node = await c.env.DB.prepare(
    "SELECT id,public_key FROM devices WHERE id=? AND public_key IS NOT NULL",
  ).bind(c.req.param("id")).first<NodeRow>();
  if (!node) throw new ApiError(404, "node_not_found", "Storage node not found");

  const heartbeat = await verifyEnvelope(body.data.heartbeat, node.public_key, heartbeatSchema)
    .catch(() => { throw new ApiError(401, "heartbeat_invalid", "Node heartbeat signature is invalid"); });
  const now = Math.floor(Date.now() / 1000);
  if (heartbeat.nodeId !== node.id || heartbeat.timestamp < now - 2 * 60 || heartbeat.timestamp > now + 60) {
    throw new ApiError(422, "heartbeat_stale", "Node heartbeat scope or timestamp is invalid");
  }
  if (heartbeat.usedBytes + heartbeat.availableBytes > heartbeat.capacityBytes) {
    throw new ApiError(422, "heartbeat_capacity_invalid", "Node heartbeat capacity values are inconsistent");
  }

  if (!isSecureNodeEndpoint(heartbeat.endpoint)) {
    throw new ApiError(422, "heartbeat_endpoint_invalid", "Node advertised endpoint must be HTTPS, except loopback HTTP for development");
  }

  await c.env.DB.prepare(
    "UPDATE devices SET status=?,storage_capacity=?,storage_used=?,available_storage=?,node_version=?,protocol_version=?,endpoint=?,health=?,last_seen=datetime('now') WHERE id=?",
  ).bind(
    heartbeat.status,
    heartbeat.capacityBytes,
    heartbeat.usedBytes,
    heartbeat.availableBytes,
    heartbeat.nodeVersion,
    heartbeat.version,
    heartbeat.endpoint,
    heartbeat.status === "online" ? "healthy" : "degraded",
    node.id,
  ).run();

  return c.json({ accepted: true, nodeId: node.id });
});

function isSecureNodeEndpoint(value: string) {
  try {
    const endpoint = new URL(value);
    const loopback = endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1" || endpoint.hostname === "[::1]";
    return endpoint.pathname === "/" && !endpoint.search && !endpoint.hash && (endpoint.protocol === "https:" || (endpoint.protocol === "http:" && loopback));
  } catch { return false; }
}

router.post("/:id/capabilities", requireAuth, async (c) => {
  const parsed = capabilityRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ApiError(422, "validation_error", parsed.error.issues[0]?.message ?? "Invalid capability request");
  const input = parsed.data;
  const user = c.get("user");
  const node = await c.env.DB.prepare("SELECT id,public_key FROM devices WHERE id=? AND owner_user_id=? AND public_key IS NOT NULL").bind(c.req.param("id"), user.id).first<NodeRow>();
  if (!node) throw new ApiError(404, "node_not_found", "Storage node not found");
  const file = await c.env.DB.prepare("SELECT status FROM files WHERE id=? AND owner_user_id=? AND status!='deleted'").bind(input.fileId, user.id).first<{ status: string }>();
  if (!file) throw new ApiError(404, "file_not_found", "File not found");
  if (input.operation === "PUT") {
    if (file.status !== "uploading" || !input.objectId.startsWith(`${input.fileId}/`)) throw new ApiError(403, "capability_scope_invalid", "Upload capability is outside the active file scope");
  } else {
    const stored = await c.env.DB.prepare("SELECT object_id FROM (SELECT sl.object_id,sl.device_id,s.file_id FROM shard_locations sl JOIN shards s ON s.id=sl.shard_id UNION ALL SELECT object_id,device_id,file_id FROM key_shares) WHERE device_id=? AND file_id=? AND object_id=? LIMIT 1").bind(node.id, input.fileId, input.objectId).first();
    if (!stored) throw new ApiError(403, "capability_scope_invalid", "Object is not assigned to this file and node");
  }
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + 5 * 60;
  const capability: StorageCapability = { version: PROTOCOL_VERSION, issuer: "horcrux-control-plane", nodeId: node.id, objectId: input.objectId, operation: input.operation, issuedAt: now, expiresAt, jti: crypto.randomUUID(), ...(input.checksum ? { checksum: input.checksum } : {}), ...(input.size !== undefined ? { size: input.size } : {}), ...(input.maxSize !== undefined ? { maxSize: input.maxSize } : {}) };
  const token = await issueCapability(capability, c.env.CAPABILITY_PRIVATE_KEY).catch(() => { throw new ApiError(503, "capability_signing_unavailable", "Capability signing is not configured"); });
  // Existing size column records an exact size for legacy PUTs and the signed
  // maximum for node-attested streamed PUTs. Receipt verification distinguishes them by checksum.
  await c.env.DB.prepare("INSERT INTO issued_capabilities (jti,user_id,device_id,file_id,object_id,operation,checksum,size,expires_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(capability.jti, user.id, node.id, input.fileId, input.objectId, input.operation, input.checksum ?? null, input.maxSize ?? input.size ?? null, new Date(expiresAt * 1000).toISOString()).run();
  return c.json({ capability: token, expiresAt: new Date(expiresAt * 1000).toISOString() }, 201);
});

router.post("/:id/receipts", requireAuth, async (c) => {
  const body = z.object({ fileId: z.uuid(), receipt: z.string().min(80).max(4096) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) throw new ApiError(422, "validation_error", "Invalid receipt submission");
  const user = c.get("user");
  const node = await c.env.DB.prepare("SELECT id,public_key FROM devices WHERE id=? AND owner_user_id=? AND public_key IS NOT NULL").bind(c.req.param("id"), user.id).first<NodeRow>();
  if (!node) throw new ApiError(404, "node_not_found", "Storage node not found");
  const receipt = await verifyEnvelope(body.data.receipt, node.public_key, storageReceiptSchema).catch(() => { throw new ApiError(401, "receipt_invalid", "Storage receipt signature is invalid"); });
  const issued = await c.env.DB.prepare("SELECT jti,device_id,object_id,operation,checksum,size,expires_at FROM issued_capabilities WHERE jti=? AND user_id=? AND file_id=?").bind(receipt.requestId, user.id, body.data.fileId).first<IssuedRow>();
  if (!issued || Date.parse(issued.expires_at) <= Date.now() || !receiptMatchesCapability(receipt, { jti: issued.jti, nodeId: issued.device_id, objectId: issued.object_id, operation: issued.operation, ...(issued.checksum ? { checksum: issued.checksum } : {}), ...(issued.checksum ? { size: issued.size ?? undefined } : { maxSize: issued.size ?? undefined }) })) throw new ApiError(422, "receipt_scope_invalid", "Storage receipt does not match an active upload capability");
  const now = Math.floor(Date.now() / 1000);
  if (receipt.timestamp < now - 10 * 60 || receipt.timestamp > now + 60) throw new ApiError(422, "receipt_stale", "Storage receipt timestamp is outside the accepted window");
  try {
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO storage_receipts (id,request_id,user_id,file_id,device_id,object_id,checksum,size,stored_at,signature) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(), receipt.requestId, user.id, body.data.fileId, node.id, receipt.objectId, receipt.checksum, receipt.size, new Date(receipt.timestamp * 1000).toISOString(), body.data.receipt),
      c.env.DB.prepare("UPDATE issued_capabilities SET receipt_received_at=datetime('now') WHERE jti=? AND receipt_received_at IS NULL").bind(receipt.requestId),
    ]);
  } catch {
    throw new ApiError(409, "receipt_already_submitted", "Storage receipt was already submitted");
  }
  return c.json({ accepted: true, nodeId: node.id, objectId: receipt.objectId });
});

export default router;
