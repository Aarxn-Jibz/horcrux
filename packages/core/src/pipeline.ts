import type { FileManifest, ObjectPlacement } from "@horcrux-file-system/shared";
import type { ShardTransport } from "@horcrux-file-system/storage";
import { base64UrlToBytes, bytesToBase64Url, sha256 } from "./bytes";
import type { CompressionProvider } from "./compression";
import type { EncryptionProvider } from "./aes";
import type { ErasureCodingProvider } from "./reed-solomon";
import type { SecretSharingProvider } from "./shamir";
import { DEFAULT_OPERATION_CONCURRENCY, mapBounded } from "./concurrency";

export type PipelineStage = "preparing" | "compressing" | "encrypting" | "encoding" | "splitting-key" | "distributing" | "verifying" | "complete";
export interface PipelineConfig { dataShards: number; parityShards: number; keyShares: number; keyThreshold: number }
export interface UploadInput { fileId: string; name: string; mimeType: string; bytes: Uint8Array }
type DistributionTask = { kind: "shard" | "key-share"; index: number; bytes: Uint8Array; nodeId: string; shardType?: "data" | "parity" };

export class BrowserFilePipeline {
  constructor(
    private readonly compression: CompressionProvider,
    private readonly encryption: EncryptionProvider,
    private readonly erasure: ErasureCodingProvider,
    private readonly secrets: SecretSharingProvider,
    private readonly storage: ShardTransport,
    private readonly operationConcurrency = DEFAULT_OPERATION_CONCURRENCY,
  ) {}

  async upload(input: UploadInput, config: PipelineConfig, nodeIds: string[], progress: (stage: PipelineStage) => void = () => {}): Promise<FileManifest> {
    progress("preparing");
    if (nodeIds.length === 0) throw new Error("No storage nodes are configured");
    const plaintextHash = await sha256(input.bytes);
    const aad = new TextEncoder().encode(input.fileId);
    progress("compressing"); const compressed = await this.compression.compress(input.bytes);
    progress("encrypting"); const encrypted = await this.encryption.encrypt(compressed, aad); const ciphertextHash = await sha256(encrypted.ciphertext);
    progress("encoding"); const encoded = await this.erasure.encode(encrypted.ciphertext, config.dataShards, config.parityShards);
    progress("splitting-key"); const shares = await this.secrets.splitSecret(encrypted.key, config.keyShares, config.keyThreshold); encrypted.key.fill(0);
    progress("distributing");
    const tasks: DistributionTask[] = [
      ...encoded.shards.map((bytes, index) => ({ kind: "shard" as const, index, bytes, nodeId: nodeIds[index % nodeIds.length]!, shardType: index < config.dataShards ? "data" as const : "parity" as const })),
      ...shares.map((bytes, index) => ({ kind: "key-share" as const, index, bytes, nodeId: nodeIds[(index + config.dataShards) % nodeIds.length]! })),
    ];
    const completed: ObjectPlacement[] = [];
    let objects: ObjectPlacement[];
    try {
      objects = await mapBounded(tasks, async (task) => {
        const stored = await this.storeObject(input.fileId, task.kind, task.index, task.bytes, task.nodeId, task.shardType);
        completed.push(stored);
        return stored;
      }, { concurrency: this.operationConcurrency });
    } catch (error) {
      await mapBounded(completed, async (object) => {
        await this.storage.deleteShard(object.nodeId, object.objectId).catch(() => {});
      }, { concurrency: this.operationConcurrency });
      throw error;
    } finally {
      shares.forEach((share) => share.fill(0));
    }
    progress("complete");
    return { fileId: input.fileId, originalName: input.name, mimeType: input.mimeType || "application/octet-stream", originalSize: input.bytes.byteLength, compressedSize: compressed.byteLength, encryptedSize: encrypted.ciphertext.byteLength, plaintextHash, ciphertextHash, encryptionAlgorithm: "AES-256-GCM", compressionAlgorithm: "zstd", encryptionIv: bytesToBase64Url(encrypted.iv), dataShards: config.dataShards, parityShards: config.parityShards, shardSize: encoded.shardSize, keyShareThreshold: config.keyThreshold, keyShareCount: config.keyShares, objects };
  }

  async download(manifest: FileManifest, progress: (stage: PipelineStage) => void = () => {}): Promise<Uint8Array> {
    progress("preparing");
    const shards: Array<Uint8Array | null> = Array(manifest.dataShards + manifest.parityShards).fill(null);
    for (const item of manifest.objects.filter((object) => object.kind === "shard")) { try { const bytes = await this.storage.getShard(item.nodeId, item.objectId); if (await sha256(bytes) === item.checksum) shards[item.index] = bytes; } catch {} }
    progress("verifying");
    const availableShards = shards.filter(Boolean).length;
    if (availableShards < manifest.dataShards) throw new Error(`Insufficient Reed-Solomon shards: need ${manifest.dataShards}, received ${availableShards}`);
    const shares: Uint8Array[] = [];
    for (const item of manifest.objects.filter((object) => object.kind === "key-share")) { try { const bytes = await this.storage.getShard(item.nodeId, item.objectId); if (await sha256(bytes) === item.checksum) shares.push(bytes); } catch {} }
    if (shares.length < manifest.keyShareThreshold) throw new Error(`Insufficient Shamir shares: need ${manifest.keyShareThreshold}, received ${shares.length}`);
    progress("encoding"); const ciphertext = await this.erasure.decode(shards, manifest.dataShards, manifest.parityShards, manifest.encryptedSize);
    if (await sha256(ciphertext) !== manifest.ciphertextHash) throw new Error("Reconstructed ciphertext failed integrity verification");
    progress("splitting-key"); const key = await this.secrets.combineShares(shares.slice(0, manifest.keyShareThreshold));
    progress("encrypting"); const compressed = await this.encryption.decrypt(ciphertext, key, base64UrlToBytes(manifest.encryptionIv), new TextEncoder().encode(manifest.fileId)); key.fill(0);
    progress("compressing"); const restored = await this.compression.decompress(compressed);
    if (restored.byteLength !== manifest.originalSize || await sha256(restored) !== manifest.plaintextHash) throw new Error("Restored file failed integrity verification");
    progress("complete"); return restored;
  }

  private async storeObject(fileId: string, kind: "shard" | "key-share", index: number, bytes: Uint8Array, nodeId: string, shardType?: "data" | "parity"): Promise<ObjectPlacement> {
    const id = crypto.randomUUID(); const objectId = `${fileId}/${kind}/${id}`; const checksum = await sha256(bytes); const stored = await this.storage.putShard(nodeId, objectId, bytes);
    return { id, kind, index, nodeId, objectId, size: stored.size, checksum, shardType, status: "stored" };
  }
}
