import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { ApiError } from "../lib/http";
import { deriveNodeId, enrollmentProofPayload, hashOpaqueToken, verifyNodeSignature } from "../lib/node-crypto";

const enrollmentSchema = z.object({
  challengeId: z.uuid(),
  token: z.string().min(32).max(512),
  publicKey: z.string().min(40).max(128),
  signature: z.string().min(40).max(128),
  name: z.string().trim().min(1).max(128),
  capacityBytes: z.int().positive(),
});

type ChallengeRow = { user_id: string; expires_at: string; used_at: string | null };
const router = new Hono<{ Bindings: Env }>();

router.post("/enroll", async (c) => {
  const parsed = enrollmentSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ApiError(422, "validation_error", parsed.error.issues[0]?.message ?? "Invalid enrollment proof");
  const input = parsed.data;
  const challenge = await c.env.DB.prepare("SELECT user_id,expires_at,used_at FROM device_enrollment_challenges WHERE id=? AND token_hash=?").bind(input.challengeId, await hashOpaqueToken(input.token)).first<ChallengeRow>();
  if (!challenge || challenge.used_at || Date.parse(challenge.expires_at) <= Date.now()) throw new ApiError(401, "enrollment_invalid", "Enrollment challenge is invalid, used, or expired");
  const proof = enrollmentProofPayload(input.challengeId, input.token, input.publicKey);
  if (!await verifyNodeSignature(input.publicKey, proof, input.signature)) throw new ApiError(401, "enrollment_proof_invalid", "Node did not prove possession of its identity key");
  const nodeId = await deriveNodeId(input.publicKey);
  try {
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO devices (id,owner_user_id,public_identifier,name,status,storage_capacity,storage_used,available_storage,public_key,protocol_version,health) VALUES (?,?,?,?,'offline',?,0,?,?,'1','unknown')").bind(nodeId, challenge.user_id, `node://${nodeId}`, input.name, input.capacityBytes, input.capacityBytes, input.publicKey),
      c.env.DB.prepare("UPDATE device_enrollment_challenges SET used_at=datetime('now') WHERE id=? AND used_at IS NULL").bind(input.challengeId),
    ]);
  } catch {
    throw new ApiError(409, "node_already_enrolled", "This node identity is already enrolled");
  }
  return c.json({ nodeId, publicKey: input.publicKey, status: "offline" }, 201);
});

export default router;
