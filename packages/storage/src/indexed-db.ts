import type { ShardTransport, StoredObjectRef } from "./index";

export class IndexedDbShardTransport implements ShardTransport {
  private readonly unavailable = new Set<string>();
  constructor(readonly nodeIds: readonly string[], private readonly databaseName = "ciphermesh-mock-network") {}
  setNodeAvailable(nodeId: string, available: boolean) { available ? this.unavailable.delete(nodeId) : this.unavailable.add(nodeId); }
  async putShard(nodeId: string, objectId: string, bytes: Uint8Array): Promise<StoredObjectRef> { this.assertOnline(nodeId); await this.transaction("readwrite", (store) => store.put({ key: `${nodeId}:${objectId}`, bytes: bytes.slice() })); return { nodeId, objectId, size: bytes.byteLength, checksum: "" }; }
  async getShard(nodeId: string, objectId: string) { this.assertOnline(nodeId); const record = await this.transaction<{ key: string; bytes: Uint8Array } | undefined>("readonly", (store) => store.get(`${nodeId}:${objectId}`)); if (!record) throw new Error(`Shard not found on ${nodeId}`); return new Uint8Array(record.bytes); }
  async deleteShard(nodeId: string, objectId: string) { await this.transaction("readwrite", (store) => store.delete(`${nodeId}:${objectId}`)); }
  async healthCheck(nodeId: string) { return this.nodeIds.includes(nodeId) && !this.unavailable.has(nodeId); }
  private assertOnline(nodeId: string) { if (!this.nodeIds.includes(nodeId) || this.unavailable.has(nodeId)) throw new Error(`Storage node ${nodeId} is unavailable`); }
  private async transaction<T = void>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest): Promise<T> { const db = await this.open(); return new Promise<T>((resolve, reject) => { const transaction = db.transaction("objects", mode); const request = action(transaction.objectStore("objects")); request.onsuccess = () => resolve(request.result as T); request.onerror = () => reject(request.error); transaction.oncomplete = () => db.close(); }); }
  private open() { return new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(this.databaseName, 1); request.onupgradeneeded = () => request.result.createObjectStore("objects", { keyPath: "key" }); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
}
