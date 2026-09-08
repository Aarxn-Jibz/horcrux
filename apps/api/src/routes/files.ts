import { Hono } from "hono";
import { fileCommitSchema, fileInitSchema } from "@ciphermesh/shared";
import type { Env } from "../env";
import type { ApiVariables } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";
import { ApiError } from "../lib/http";
import { getObjects, getOwnedFile, serializeFile } from "../data/files";

const router = new Hono<{ Bindings: Env; Variables: ApiVariables }>();
router.use("*", requireAuth);

router.post("/init", async (c) => {
  const parsed = fileInitSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ApiError(422, "validation_error", parsed.error.issues[0]?.message ?? "Invalid file metadata");
  const input = parsed.data; const user = c.get("user"); const sessionId = crypto.randomUUID(); const expiresAt = new Date(Date.now() + 24 * 3600_000).toISOString();
  const nodes = await c.env.DB.prepare("SELECT id,public_identifier,name,status,storage_capacity,storage_used,last_seen FROM devices WHERE status IN ('online','degraded') ORDER BY storage_used * 1.0 / MAX(storage_capacity,1), id LIMIT 32").all();
  if (nodes.results.length === 0) throw new ApiError(409, "no_storage_nodes", "No storage nodes are currently available");
  try { await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO files (id,owner_user_id,original_name,mime_type,original_size,plaintext_hash,status,rs_data_shards,rs_parity_shards,key_share_threshold,key_share_count) VALUES (?,?,?,?,?,?,'uploading',?,?,?,?)").bind(input.fileId, user.id, input.originalName, input.mimeType, input.originalSize, input.plaintextHash, input.dataShards, input.parityShards, input.keyShareThreshold, input.keyShareCount),
    c.env.DB.prepare("INSERT INTO upload_sessions (id,file_id,user_id,status,expires_at) VALUES (?,?,?,'initialized',?)").bind(sessionId, input.fileId, user.id, expiresAt),
  ]); } catch { throw new ApiError(409, "file_exists", "This file upload has already been initialized"); }
  return c.json({ fileId: input.fileId, uploadSessionId: sessionId, expiresAt, nodes: nodes.results }, 201);
});

router.post("/:id/complete", async (c) => {
  const file = await getOwnedFile(c.env.DB, c.req.param("id"), c.get("user").id);
  if (file.status !== "uploading") throw new ApiError(409, "invalid_upload_state", "File upload is not awaiting completion");
  const parsed = fileCommitSchema.safeParse(await c.req.json().catch(() => null)); if (!parsed.success) throw new ApiError(422, "validation_error", parsed.error.issues[0]?.message ?? "Invalid object metadata");
  const input = parsed.data; const shards = input.objects.filter((item) => item.kind === "shard" && item.status === "stored"); const shares = input.objects.filter((item) => item.kind === "key-share" && item.status === "stored");
  if (shards.some((item) => !item.shardType || item.index >= file.rs_data_shards + file.rs_parity_shards) || shares.some((item) => item.index >= file.key_share_count)) throw new ApiError(422, "invalid_object_index", "Shard or key-share metadata is outside the configured range");
  if (shards.length < file.rs_data_shards) throw new ApiError(409, "insufficient_shards", `At least ${file.rs_data_shards} stored shards are required`);
  if (shares.length < file.key_share_threshold) throw new ApiError(409, "insufficient_key_shares", `At least ${file.key_share_threshold} stored key shares are required`);
  if (new Set(shards.map((item) => item.index)).size !== shards.length || new Set(shares.map((item) => item.index)).size !== shares.length) throw new ApiError(422, "duplicate_object_index", "Object indexes must be unique");
  const statements: D1PreparedStatement[] = [];
  for (const item of shards) { statements.push(c.env.DB.prepare("INSERT INTO shards (id,file_id,shard_index,shard_type,size,checksum,status) VALUES (?,?,?,?,?,?,'stored')").bind(item.id, file.id, item.index, item.shardType, item.size, item.checksum)); statements.push(c.env.DB.prepare("INSERT INTO shard_locations (id,shard_id,device_id,object_id,status,stored_at) VALUES (?,?,?,?,'stored',datetime('now'))").bind(crypto.randomUUID(), item.id, item.nodeId, item.objectId)); }
  for (const item of shares) statements.push(c.env.DB.prepare("INSERT INTO key_shares (id,file_id,share_index,checksum,size,device_id,object_id,status) VALUES (?,?,?,?,?,?,?,'stored')").bind(item.id, file.id, item.index, item.checksum, item.size, item.nodeId, item.objectId));
  statements.push(c.env.DB.prepare("UPDATE files SET compressed_size=?,encrypted_size=?,ciphertext_hash=?,encryption_iv=?,rs_shard_size=?,status='available',completed_at=datetime('now') WHERE id=?").bind(input.compressedSize, input.encryptedSize, input.ciphertextHash, input.encryptionIv, input.shardSize, file.id));
  statements.push(c.env.DB.prepare("UPDATE upload_sessions SET status='complete',updated_at=datetime('now') WHERE file_id=? AND user_id=? AND status!='aborted'").bind(file.id, c.get("user").id));
  try { await c.env.DB.batch(statements); } catch { throw new ApiError(422, "metadata_commit_failed", "Shard metadata could not be committed"); }
  return c.json({ fileId: file.id, status: "available" });
});

router.get("/", async (c) => { const result = await c.env.DB.prepare("SELECT * FROM files WHERE owner_user_id=? AND status!='deleted' ORDER BY created_at DESC").bind(c.get("user").id).all<import("../data/files").FileRow>(); return c.json({ files: result.results.map(serializeFile) }); });
router.get("/:id/download-manifest", async (c) => { const file = await getOwnedFile(c.env.DB, c.req.param("id"), c.get("user").id); if (file.status !== "available") throw new ApiError(409, "file_unavailable", "File is not available for reconstruction"); return c.json({ ...serializeFile(file), objects: await getObjects(c.env.DB, file.id) }); });
router.get("/:id/shards", async (c) => { const file = await getOwnedFile(c.env.DB, c.req.param("id"), c.get("user").id); return c.json({ objects: await getObjects(c.env.DB, file.id) }); });
router.get("/:id", async (c) => c.json({ ...(serializeFile(await getOwnedFile(c.env.DB, c.req.param("id"), c.get("user").id))), objects: await getObjects(c.env.DB, c.req.param("id")) }));
router.delete("/:id", async (c) => { const file = await getOwnedFile(c.env.DB, c.req.param("id"), c.get("user").id); await c.env.DB.batch([c.env.DB.prepare("UPDATE files SET status='deleted',deleted_at=datetime('now') WHERE id=? AND owner_user_id=?").bind(file.id, c.get("user").id), c.env.DB.prepare("UPDATE upload_sessions SET status='aborted',updated_at=datetime('now') WHERE file_id=? AND status!='complete'").bind(file.id)]); return c.body(null, 204); });

export default router;
