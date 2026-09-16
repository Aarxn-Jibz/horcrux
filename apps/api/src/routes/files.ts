import { Hono } from "hono";
import { fileCommitSchema, fileInitSchema } from "@horcrux-file-system/shared";
import { z } from "zod";
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
  const requiredNodes = input.storageMode !== "mock" ? Math.max(input.dataShards + input.parityShards, input.keyShareCount) : 1;
  const nodes = await c.env.DB.prepare(`
    SELECT id,public_identifier,name,endpoint,status,storage_capacity,storage_used,available_storage,last_seen,protocol_version
    FROM devices
    WHERE (owner_user_id=? OR owner_user_id IS NULL)
      AND ${input.storageMode !== "mock" ? "public_key IS NOT NULL AND endpoint IS NOT NULL" : "public_key IS NULL"}
      AND status IN ('online','degraded')
      AND available_storage > 0
      AND (
        public_key IS NULL
        OR (health IN ('healthy','degraded') AND protocol_version='1' AND last_seen >= datetime('now','-2 minutes'))
      )
    ORDER BY storage_used * 1.0 / MAX(storage_capacity,1), id
    LIMIT ${requiredNodes}
  `).bind(user.id).all();
  if (nodes.results.length < requiredNodes) throw new ApiError(409, "insufficient_storage_nodes", input.storageMode !== "mock" ? `Real storage mode requires ${requiredNodes} eligible physical nodes; enroll nodes with a reachable endpoint and wait for their heartbeat` : "No mock storage nodes are currently available");
  try { await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO files (id,owner_user_id,original_name,mime_type,original_size,plaintext_hash,status,rs_data_shards,rs_parity_shards,key_share_threshold,key_share_count,format_version) VALUES (?,?,?,?,?,?,'uploading',?,?,?,?,?)").bind(input.fileId, user.id, input.originalName, input.mimeType, input.originalSize, input.plaintextHash, input.dataShards, input.parityShards, input.keyShareThreshold, input.keyShareCount, input.formatVersion ?? 1),
    c.env.DB.prepare("INSERT INTO upload_sessions (id,file_id,user_id,status,expires_at) VALUES (?,?,?,'initialized',?)").bind(sessionId, input.fileId, user.id, expiresAt),
  ]); } catch { throw new ApiError(409, "file_exists", "This file upload has already been initialized"); }
  return c.json({ fileId: input.fileId, uploadSessionId: sessionId, expiresAt, nodes: nodes.results }, 201);
});

router.post("/:id/complete", async (c) => {
  const file = await getOwnedFile(c.env.DB, c.req.param("id"), c.get("user").id);
  if (file.status === "available" && !file.deletion_state) return c.json({ fileId: file.id, status: "available" });
  if (file.status !== "uploading") throw new ApiError(409, "invalid_upload_state", "File upload is not awaiting completion");
  const session = await c.env.DB.prepare("SELECT expires_at,status FROM upload_sessions WHERE file_id=? AND user_id=? ORDER BY created_at DESC LIMIT 1").bind(file.id, c.get("user").id).first<{ expires_at: string; status: string }>();
  if (!session || session.status === "aborted" || Date.parse(session.expires_at) <= Date.now()) throw new ApiError(409, "upload_expired", "The upload session has expired or was aborted");
  const parsed = fileCommitSchema.safeParse(await c.req.json().catch(() => null)); if (!parsed.success) throw new ApiError(422, "validation_error", parsed.error.issues[0]?.message ?? "Invalid object metadata");
  const input = parsed.data; const shards = input.objects.filter((item) => item.kind === "shard" && item.status === "stored"); const shares = input.objects.filter((item) => item.kind === "key-share" && item.status === "stored");
  if (shards.some((item) => !item.shardType || item.index >= file.rs_data_shards + file.rs_parity_shards) || shares.some((item) => item.index >= file.key_share_count)) throw new ApiError(422, "invalid_object_index", "Shard or key-share metadata is outside the configured range");
  if (shards.length < file.rs_data_shards) throw new ApiError(409, "insufficient_shards", `At least ${file.rs_data_shards} stored shards are required`);
  if (shares.length < file.key_share_threshold) throw new ApiError(409, "insufficient_key_shares", `At least ${file.key_share_threshold} stored key shares are required`);
  if (new Set(shards.map((item) => item.index)).size !== shards.length || new Set(shares.map((item) => item.index)).size !== shares.length) throw new ApiError(422, "duplicate_object_index", "Object indexes must be unique");
  for (const item of input.objects) {
    const confirmation = await c.env.DB.prepare("SELECT d.public_key,r.id receipt_id FROM devices d LEFT JOIN storage_receipts r ON r.device_id=d.id AND r.object_id=? AND r.checksum=? AND r.size=? AND r.file_id=? WHERE d.id=?").bind(item.objectId, item.checksum, item.size, file.id, item.nodeId).first<{ public_key: string | null; receipt_id: string | null }>();
    if (!confirmation) throw new ApiError(422, "invalid_storage_node", "Object references an unknown storage node");
    if (confirmation.public_key && !confirmation.receipt_id) throw new ApiError(409, "storage_receipt_required", "A verified node receipt is required before completing this upload");
  }
  // D1 batch() is transactional. Keeping the ownership check inside that batch
  // means a terminated Worker cannot leave a durable, half-committed claim.
  const guard = "EXISTS (SELECT 1 FROM files WHERE id=? AND owner_user_id=? AND status='uploading' AND deletion_state IS NULL) AND EXISTS (SELECT 1 FROM upload_sessions WHERE file_id=? AND user_id=? AND status IN ('initialized','distributing','committing') AND julianday(expires_at)>julianday('now'))";
  const guardBindings = [file.id, c.get("user").id, file.id, c.get("user").id];
  const statements: D1PreparedStatement[] = [];
  for (const item of shards) { statements.push(c.env.DB.prepare(`INSERT INTO shards (id,file_id,shard_index,shard_type,size,checksum,status) SELECT ?,?,?,?,?,?,'stored' WHERE ${guard}`).bind(item.id, file.id, item.index, item.shardType, item.size, item.checksum, ...guardBindings)); statements.push(c.env.DB.prepare(`INSERT INTO shard_locations (id,shard_id,device_id,object_id,status,stored_at) SELECT ?,?,?,?,'stored',datetime('now') WHERE ${guard}`).bind(crypto.randomUUID(), item.id, item.nodeId, item.objectId, ...guardBindings)); }
  for (const item of shares) statements.push(c.env.DB.prepare(`INSERT INTO key_shares (id,file_id,share_index,checksum,size,device_id,object_id,status) SELECT ?,?,?,?,?,?,?,'stored' WHERE ${guard}`).bind(item.id, file.id, item.index, item.checksum, item.size, item.nodeId, item.objectId, ...guardBindings));
  statements.push(c.env.DB.prepare(`UPDATE files SET compressed_size=?,encrypted_size=?,ciphertext_hash=?,encryption_iv=?,rs_shard_size=?,chunk_size=?,chunk_count=?,nonce_prefix=?,status='available',completed_at=datetime('now') WHERE id=? AND owner_user_id=? AND status='uploading' AND deletion_state IS NULL AND EXISTS (SELECT 1 FROM upload_sessions WHERE file_id=? AND user_id=? AND status IN ('initialized','distributing','committing') AND julianday(expires_at)>julianday('now'))`).bind(input.compressedSize ?? null, input.encryptedSize ?? null, input.ciphertextHash ?? null, input.encryptionIv ?? null, input.shardSize ?? null, input.chunkSize ?? null, input.chunkCount ?? null, input.noncePrefix ?? null, file.id, c.get("user").id, file.id, c.get("user").id));
  const publishIndex = statements.length - 1;
  statements.push(c.env.DB.prepare("UPDATE upload_sessions SET status='complete',updated_at=datetime('now') WHERE file_id=? AND user_id=? AND status IN ('initialized','distributing','committing') AND EXISTS (SELECT 1 FROM files WHERE id=? AND owner_user_id=? AND status='available')").bind(file.id, c.get("user").id, file.id, c.get("user").id));
  let results: D1Result[];
  try { results = await c.env.DB.batch(statements); } catch { throw new ApiError(422, "metadata_commit_failed", "Shard metadata could not be committed"); }
  if (!results[publishIndex]?.meta.changes) {
    const current = await getOwnedFile(c.env.DB, file.id, c.get("user").id);
    if (current.status === "available" && !current.deletion_state) return c.json({ fileId: current.id, status: "available" });
    throw new ApiError(409, "invalid_upload_state", "File upload state changed concurrently");
  }
  return c.json({ fileId: file.id, status: "available" });
});

async function abortUpload(db: D1Database, file: { id: string }, userId: string) {
  const objects = await db.prepare("SELECT MIN(jti) source_id,CASE WHEN object_id LIKE '%/key-share/%' THEN 'key-share' ELSE 'shard' END object_kind,device_id,object_id FROM issued_capabilities WHERE user_id=? AND file_id=? AND operation='PUT' GROUP BY device_id,object_id").bind(userId, file.id).all<DeletionCandidate>();
  const terminal = objects.results.length === 0;
  const statements: D1PreparedStatement[] = [
    db.prepare("UPDATE upload_sessions SET status='aborted',updated_at=datetime('now') WHERE file_id=? AND user_id=? AND status IN ('initialized','distributing','committing') AND EXISTS (SELECT 1 FROM files WHERE id=? AND owner_user_id=? AND status='uploading')").bind(file.id, userId, file.id, userId),
    db.prepare(`UPDATE files SET status=?,deletion_state=?,deletion_requested_at=CASE WHEN ? THEN datetime('now') ELSE NULL END,deleted_at=CASE WHEN ? THEN datetime('now') ELSE NULL END WHERE id=? AND owner_user_id=? AND status='uploading' AND EXISTS (SELECT 1 FROM upload_sessions WHERE file_id=? AND user_id=? AND status='aborted')`).bind(terminal ? "deleted" : "failed", terminal ? null : "pending", !terminal, terminal, file.id, userId, file.id, userId),
    ...objects.results.map((object) => db.prepare("INSERT INTO file_deletion_tasks (id,file_id,device_id,object_id,object_kind,source_id) SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM files WHERE id=? AND owner_user_id=? AND deletion_state='pending') ON CONFLICT DO NOTHING").bind(crypto.randomUUID(), file.id, object.device_id, object.object_id, object.object_kind, object.source_id, file.id, userId)),
  ];
  const results = await db.batch(statements);
  return Boolean(results[0]?.meta.changes);
}

router.post("/:id/state", async (c) => { const file = await getOwnedFile(c.env.DB, c.req.param("id"), c.get("user").id); if (file.status !== "uploading") throw new ApiError(409, "invalid_upload_state", "File upload is not active"); const parsed = z.object({ status: z.enum(["distributing", "aborted"]) }).safeParse(await c.req.json().catch(() => null)); if (!parsed.success) throw new ApiError(422, "validation_error", "Invalid upload state"); if (parsed.data.status === "aborted") { if (!await abortUpload(c.env.DB, file, c.get("user").id)) throw new ApiError(409, "invalid_upload_state", "File upload state changed concurrently"); } else { const transition = await c.env.DB.prepare("UPDATE upload_sessions SET status='distributing',updated_at=datetime('now') WHERE file_id=? AND user_id=? AND status IN ('initialized','distributing') AND EXISTS (SELECT 1 FROM files WHERE id=? AND owner_user_id=? AND status='uploading')").bind(file.id, c.get("user").id, file.id, c.get("user").id).run(); if (!transition.meta.changes) throw new ApiError(409, "invalid_upload_state", "File upload state changed concurrently"); } return c.json({ fileId: file.id, status: parsed.data.status }); });

router.get("/", async (c) => { const result = await c.env.DB.prepare("SELECT * FROM files WHERE owner_user_id=? AND status!='deleted' ORDER BY created_at DESC").bind(c.get("user").id).all<import("../data/files").FileRow>(); return c.json({ files: result.results.map(serializeFile) }); });
router.get("/:id/download-manifest", async (c) => { const file = await getOwnedFile(c.env.DB, c.req.param("id"), c.get("user").id); if (file.status !== "available" || file.deletion_state) throw new ApiError(409, "file_unavailable", "File is not available for reconstruction"); return c.json({ ...serializeFile(file), objects: await getObjects(c.env.DB, file.id) }); });
router.get("/:id/shards", async (c) => { const file = await getOwnedFile(c.env.DB, c.req.param("id"), c.get("user").id); if (file.deletion_state) throw new ApiError(409, "file_unavailable", "File is being deleted"); return c.json({ objects: await getObjects(c.env.DB, file.id) }); });
router.get("/:id", async (c) => { const file = await getOwnedFile(c.env.DB, c.req.param("id"), c.get("user").id); return c.json({ ...serializeFile(file), objects: file.deletion_state ? [] : await getObjects(c.env.DB, file.id) }); });

type DeletionCandidate = { source_id: string; object_kind: "shard" | "key-share"; device_id: string; object_id: string };

async function pendingDeletionCount(db: D1Database, fileId: string) {
  return (await db.prepare("SELECT COUNT(*) count FROM file_deletion_tasks WHERE file_id=? AND status='pending'").bind(fileId).first<{ count: number }>())?.count ?? 0;
}

router.delete("/:id", async (c) => {
  const user = c.get("user"); const file = await getOwnedFile(c.env.DB, c.req.param("id"), user.id);
  if (file.deletion_state) return c.json({ fileId: file.id, status: "deleting", pendingObjects: await pendingDeletionCount(c.env.DB, file.id) }, 202);
  if (file.status === "available") {
    const objects = await c.env.DB.prepare("SELECT sl.id source_id,'shard' object_kind,sl.device_id,sl.object_id FROM shard_locations sl JOIN shards s ON s.id=sl.shard_id WHERE s.file_id=? AND s.status='stored' AND sl.status='stored' UNION ALL SELECT ks.id source_id,'key-share' object_kind,ks.device_id,ks.object_id FROM key_shares ks WHERE ks.file_id=? AND ks.status='stored'").bind(file.id, file.id).all<DeletionCandidate>();
    const statements: D1PreparedStatement[] = [
      c.env.DB.prepare("UPDATE files SET deletion_state='pending',deletion_requested_at=datetime('now') WHERE id=? AND owner_user_id=? AND status='available' AND deletion_state IS NULL").bind(file.id, user.id),
      ...objects.results.map((object) => c.env.DB.prepare("INSERT INTO file_deletion_tasks (id,file_id,device_id,object_id,object_kind,source_id) SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM files WHERE id=? AND owner_user_id=? AND deletion_state='pending') ON CONFLICT(file_id,object_kind,source_id) DO NOTHING").bind(crypto.randomUUID(), file.id, object.device_id, object.object_id, object.object_kind, object.source_id, file.id, user.id)),
    ];
    try { await c.env.DB.batch(statements); } catch { throw new ApiError(503, "deletion_init_failed", "Deletion could not be initiated"); }
    const current = await getOwnedFile(c.env.DB, file.id, user.id);
    if (!current.deletion_state) throw new ApiError(409, "invalid_file_state", "File state changed concurrently");
    return c.json({ fileId: file.id, status: "deleting", pendingObjects: await pendingDeletionCount(c.env.DB, file.id) }, 202);
  }
  if (file.status === "uploading") { if (!await abortUpload(c.env.DB, file, user.id)) throw new ApiError(409, "invalid_upload_state", "File upload state changed concurrently"); const pendingObjects = await pendingDeletionCount(c.env.DB, file.id); return pendingObjects ? c.json({ fileId: file.id, status: "deleting", pendingObjects }, 202) : c.body(null, 204); }
  const deleted = await c.env.DB.prepare("UPDATE files SET status='deleted',deleted_at=datetime('now') WHERE id=? AND owner_user_id=? AND status=? AND deletion_state IS NULL").bind(file.id, user.id, file.status).run(); if (!deleted.meta.changes) throw new ApiError(409, "invalid_upload_state", "File state changed concurrently"); return c.body(null, 204);
});

export default router;
