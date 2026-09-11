import type { ShardTransport, StoredObjectRef } from "./index";

export class MemoryShardTransport implements ShardTransport {
  private readonly objects = new Map<string, Uint8Array>();
  private readonly unavailable = new Set<string>();
  constructor(readonly nodeIds: readonly string[]) {}
  setNodeAvailable(nodeId: string, available: boolean) { available ? this.unavailable.delete(nodeId) : this.unavailable.add(nodeId); }
  async putShard(nodeId: string, objectId: string, bytes: Uint8Array): Promise<StoredObjectRef> { this.assertOnline(nodeId); this.objects.set(`${nodeId}:${objectId}`, bytes.slice()); return { nodeId, objectId, size: bytes.byteLength, checksum: "" }; }
  async getShard(nodeId: string, objectId: string, signal?: AbortSignal) { signal?.throwIfAborted(); this.assertOnline(nodeId); const bytes = this.objects.get(`${nodeId}:${objectId}`); if (!bytes) throw new Error(`Shard not found on ${nodeId}`); return bytes.slice(); }
  async deleteShard(nodeId: string, objectId: string) { this.objects.delete(`${nodeId}:${objectId}`); }
  async healthCheck(nodeId: string) { return this.nodeIds.includes(nodeId) && !this.unavailable.has(nodeId); }
  deleteObject(nodeId: string, objectId: string) { this.objects.delete(`${nodeId}:${objectId}`); }
  get objectCount() { return this.objects.size; }
  corruptObject(nodeId: string, objectId: string) { const bytes = this.objects.get(`${nodeId}:${objectId}`); if (bytes?.length) bytes[0] = bytes[0]! ^ 0xff; }
  private assertOnline(nodeId: string) { if (!this.nodeIds.includes(nodeId) || this.unavailable.has(nodeId)) throw new Error(`Storage node ${nodeId} is unavailable`); }
}
