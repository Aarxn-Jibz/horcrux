export interface StoredObjectRef { nodeId: string; objectId: string; size: number; checksum: string }
export interface PutShardOptions { checksum?: string; signal?: AbortSignal }
export type ByteStream = AsyncIterable<Uint8Array>;
export interface ShardTransport {
  putShard(nodeId: string, objectId: string, bytes: Uint8Array, options?: PutShardOptions): Promise<StoredObjectRef>;
  getShard(nodeId: string, objectId: string, signal?: AbortSignal): Promise<Uint8Array>;
  deleteShard(nodeId: string, objectId: string): Promise<void>;
  healthCheck(nodeId: string): Promise<boolean>;
  /** Optional bounded-memory object operations used by the v2 striped format. */
  putShardStream?(nodeId: string, objectId: string, bytes: ByteStream, options: PutShardOptions & { size: number }): Promise<StoredObjectRef>;
  getShardStream?(nodeId: string, objectId: string, signal?: AbortSignal): Promise<ByteStream>;
}
export * from "./indexed-db";
export * from "./memory";
export * from "./http";
