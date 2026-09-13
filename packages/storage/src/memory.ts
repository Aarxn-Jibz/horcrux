import type { ByteStream, ShardTransport, StoredObjectRef } from "./index";
import { concat } from "./stream";

export class MemoryShardTransport implements ShardTransport {
  private readonly objects = new Map<string, Uint8Array>();
  private readonly unavailable = new Set<string>();
  constructor(readonly nodeIds: readonly string[]) {}
  setNodeAvailable(nodeId: string, available: boolean) { available ? this.unavailable.delete(nodeId) : this.unavailable.add(nodeId); }
  async putShard(nodeId: string, objectId: string, bytes: Uint8Array): Promise<StoredObjectRef> { this.assertOnline(nodeId); this.objects.set(`${nodeId}:${objectId}`, bytes.slice()); return { nodeId, objectId, size: bytes.byteLength, checksum: await sha256(bytes) }; }
  async getShard(nodeId: string, objectId: string, signal?: AbortSignal) { signal?.throwIfAborted(); this.assertOnline(nodeId); const bytes = this.objects.get(`${nodeId}:${objectId}`); if (!bytes) throw new Error(`Shard not found on ${nodeId}`); return bytes.slice(); }
  async deleteShard(nodeId: string, objectId: string) { this.objects.delete(`${nodeId}:${objectId}`); }
  async healthCheck(nodeId: string) { return this.nodeIds.includes(nodeId) && !this.unavailable.has(nodeId); }
  async putShardStream(nodeId: string, objectId: string, bytes: ByteStream, options: { checksum?: string; maxSize: number }): Promise<StoredObjectRef> { const body = await concat(bytes); if (body.byteLength > options.maxSize) throw new Error("Stream exceeds maximum size"); return this.putShard(nodeId, objectId, body); }
  async getShardStream(nodeId: string, objectId: string, signal?: AbortSignal, start = 0) { return (async function* (transport: MemoryShardTransport) { yield (await transport.getShard(nodeId, objectId, signal)).slice(start); })(this); }
  deleteObject(nodeId: string, objectId: string) { this.objects.delete(`${nodeId}:${objectId}`); }
  get objectCount() { return this.objects.size; }
  corruptObject(nodeId: string, objectId: string) { const bytes = this.objects.get(`${nodeId}:${objectId}`); if (bytes?.length) bytes[0] = bytes[0]! ^ 0xff; }
  private assertOnline(nodeId: string) { if (!this.nodeIds.includes(nodeId) || this.unavailable.has(nodeId)) throw new Error(`Storage node ${nodeId} is unavailable`); }
}

async function sha256(bytes: Uint8Array) { const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)); return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""); }
