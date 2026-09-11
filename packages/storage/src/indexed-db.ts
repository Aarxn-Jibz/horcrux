import type { ShardTransport, StoredObjectRef } from "./index";

type StoredRecord = { key: string; bytes: Uint8Array };

export class IndexedDbShardTransport implements ShardTransport {
  private readonly unavailable = new Set<string>();

  constructor(readonly nodeIds: readonly string[], private readonly databaseName = "horcrux-file-system-mock-network") {}

  setNodeAvailable(nodeId: string, available: boolean) {
    if (available) this.unavailable.delete(nodeId);
    else this.unavailable.add(nodeId);
  }

  async putShard(nodeId: string, objectId: string, bytes: Uint8Array): Promise<StoredObjectRef> {
    this.assertOnline(nodeId);
    // A narrow view may retain or clone the complete Reed-Solomon backing store.
    const storedBytes = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
    await this.transaction("readwrite", (store) => store.put({ key: `${nodeId}:${objectId}`, bytes: storedBytes }));
    return { nodeId, objectId, size: bytes.byteLength, checksum: "" };
  }

  async getShard(nodeId: string, objectId: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    this.assertOnline(nodeId);
    const record = await this.transaction<StoredRecord | undefined>("readonly", (store) => store.get(`${nodeId}:${objectId}`));
    signal?.throwIfAborted();
    if (!record) throw new Error(`Shard not found on ${nodeId}`);
    return record.bytes;
  }

  async deleteShard(nodeId: string, objectId: string) {
    await this.transaction("readwrite", (store) => store.delete(`${nodeId}:${objectId}`));
  }

  async healthCheck(nodeId: string) {
    return this.nodeIds.includes(nodeId) && !this.unavailable.has(nodeId);
  }

  private assertOnline(nodeId: string) {
    if (!this.nodeIds.includes(nodeId) || this.unavailable.has(nodeId)) {
      throw new Error(`Storage node ${nodeId} is unavailable`);
    }
  }

  private async transaction<T = void>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest): Promise<T> {
    const database = await this.open();
    return new Promise<T>((resolve, reject) => {
      const transaction = database.transaction("objects", mode);
      const request = action(transaction.objectStore("objects"));
      let result = undefined as T;
      request.onsuccess = () => { result = request.result as T; };
      transaction.oncomplete = () => {
        database.close();
        resolve(result);
      };
      transaction.onerror = () => {
        database.close();
        reject(transaction.error ?? request.error);
      };
      transaction.onabort = () => {
        database.close();
        reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
      };
    });
  }

  private open() {
    return new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("objects", { keyPath: "key" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
}
