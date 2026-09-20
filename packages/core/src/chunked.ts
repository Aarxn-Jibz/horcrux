import type { ObjectPlacement } from "@horcrux-file-system/shared";
import type { ByteStream, ShardTransport } from "@horcrux-file-system/storage";
import { asWebCryptoBytes, base64UrlToBytes, bytesToBase64Url, concatBytes } from "./bytes";
import type { CompressionProvider } from "./compression";
import type { EncryptionProvider } from "./aes";
import type { ErasureCodingProvider } from "./reed-solomon";
import type { SecretSharingProvider } from "./shamir";
import { Sha256Stream } from "./sha256-stream";
import { isFileSink, type ReconstructionOutput } from "./output";

export const CHUNKED_FORMAT_VERSION = 2;
export const CHUNKED_PLAINTEXT_BYTES = 1024 * 1024;
const RECORD_HEADER_BYTES = 20;
const encoder = new TextEncoder();

export interface ChunkedUploadInput { fileId: string; name: string; mimeType: string; size: number; source: () => ByteStream; plaintextHash?: string }
export interface ChunkedManifest { formatVersion: 2; fileId: string; originalName: string; mimeType: string; originalSize: number; plaintextHash: string; encryptionAlgorithm: "AES-256-GCM"; compressionAlgorithm: "zstd"; chunkSize: number; chunkCount: number; noncePrefix: string; dataShards: number; parityShards: number; keyShareThreshold: number; keyShareCount: number; objects: ObjectPlacement[] }
export interface ChunkedConfig { dataShards: number; parityShards: number; keyShares: number; keyThreshold: number }

/**
 * V2 uses independently compressed and AES-GCM authenticated 4 MiB frames.
 * A random 64-bit prefix plus an unsigned 32-bit frame counter forms each 96-bit nonce.
 * One source pass fans each encrypted stripe out to the nodes. PUT capabilities are
 * bounded conservatively; final checksums and sizes come from node receipts.
 */
export class ChunkedFilePipeline {
  constructor(private readonly compression: CompressionProvider, private readonly encryption: EncryptionProvider, private readonly erasure: ErasureCodingProvider, private readonly secrets: SecretSharingProvider, private readonly storage: ShardTransport) {}

  async upload(input: ChunkedUploadInput, config: ChunkedConfig, nodeIds: string[]): Promise<ChunkedManifest> {
    if (!this.storage.putShardStream) throw new Error("Selected storage transport does not support chunked uploads");
    if (nodeIds.length < Math.max(config.dataShards + config.parityShards, config.keyShares)) throw new Error("Chunked uploads require one placement for every shard/share index");
    const key = crypto.getRandomValues(new Uint8Array(32));
    const noncePrefix = crypto.getRandomValues(new Uint8Array(8));
    const plaintextHash = input.plaintextHash ?? await hashSource(input.source());
    const shares = await this.secrets.splitSecret(key, config.keyShares, config.keyThreshold);
    const streamKey = key.slice();
    key.fill(0);
    const objects: ObjectPlacement[] = [];
    try {
      const fanout = new StripeFanout(this.stripes(input, config, streamKey, noncePrefix), config.dataShards + config.parityShards);
      const shardUploads = Array.from({ length: config.dataShards + config.parityShards }, async (_, index) => {
        const objectId = `${input.fileId}/shard/${crypto.randomUUID()}`;
        const stored = await this.storage.putShardStream!(nodeIds[index]!, objectId, fanout.stream(index), { maxSize: shardMaximumSize(input.size, config.dataShards) });
        const object = { id: crypto.randomUUID(), kind: "shard" as const, index, nodeId: nodeIds[index]!, objectId, size: stored.size, checksum: stored.checksum, shardType: index < config.dataShards ? "data" as const : "parity" as const, status: "stored" as const };
        objects.push(object);
        return object;
      });
      try { await Promise.all(shardUploads); }
      catch (error) { fanout.abort(error); await Promise.allSettled(shardUploads); throw error; }
      const shareUploads = shares.map(async (share, index) => {
        const objectId = `${input.fileId}/key-share/${crypto.randomUUID()}`; const checksum = new Sha256Stream().update(share).hex();
        const stored = await this.storage.putShard(nodeIds[index]!, objectId, share, { checksum });
        const object = { id: crypto.randomUUID(), kind: "key-share" as const, index, nodeId: nodeIds[index]!, objectId, size: stored.size, checksum, status: "stored" as const };
        objects.push(object);
        return object;
      });
      try { await Promise.all(shareUploads); }
      catch (error) { await Promise.allSettled(shareUploads); throw error; }
    } catch (error) {
      await Promise.all(objects.map((object) => this.storage.deleteShard(object.nodeId, object.objectId).catch(() => {})));
      throw error;
    } finally { streamKey.fill(0); shares.forEach((share) => share.fill(0)); }
    return { formatVersion: 2, fileId: input.fileId, originalName: input.name, mimeType: input.mimeType || "application/octet-stream", originalSize: input.size, plaintextHash, encryptionAlgorithm: "AES-256-GCM", compressionAlgorithm: "zstd", chunkSize: CHUNKED_PLAINTEXT_BYTES, chunkCount: Math.ceil(input.size / CHUNKED_PLAINTEXT_BYTES), noncePrefix: bytesToBase64Url(noncePrefix), dataShards: config.dataShards, parityShards: config.parityShards, keyShareThreshold: config.keyThreshold, keyShareCount: config.keyShares, objects };
  }

  /** Reconstructs v2 directly to a consumer; no complete plaintext or shard is accumulated. */
  async downloadTo(manifest: ChunkedManifest, output: ReconstructionOutput) {
    let key: Uint8Array | undefined;
    let readers: RecordReader[] = [];
    let selected: ObjectPlacement[] = [];
    try {
      if (!this.storage.getShardStream) throw new Error("Selected storage transport does not support chunked downloads");
      const shares = await this.retrieveShares(manifest);
      try { key = await this.secrets.combineShares(shares.slice(0, manifest.keyShareThreshold)); } finally { shares.forEach((share) => share.fill(0)); }
      const available = (await Promise.all(manifest.objects.filter((object) => object.kind === "shard").map(async (object) => ({ object, healthy: await this.storage.healthCheck(object.nodeId) })))).filter((candidate) => candidate.healthy).map((candidate) => candidate.object);
      if (available.length < manifest.dataShards) throw new Error(`Insufficient reachable Reed-Solomon shards: need ${manifest.dataShards}, received ${available.length}`);
      const prefix = base64UrlToBytes(manifest.noncePrefix); const originalHash = new Sha256Stream(); let written = 0;

      const readFrame = async (frame: number, frameStart: number) => {
        let failure: unknown;
        const attempt = async (objects: ObjectPlacement[], activeReaders: RecordReader[]) => {
          const records: Awaited<ReturnType<RecordReader["next"]>>[] = [];
          let encrypted: Uint8Array | undefined;
          try {
            for (const reader of activeReaders) records.push(await reader.next());
            if (records.some((record) => record.index !== frame || record.originalLength < 0 || record.encryptedLength < 16)) throw new Error("Invalid or reordered striped record");
            const first = records[0]!;
            if (records.some((record) => record.originalLength !== first.originalLength || record.encryptedLength !== first.encryptedLength || record.shardSize !== first.shardSize)) throw new Error("Striped record metadata disagrees between nodes");
            const shards: Array<Uint8Array | null> = Array(manifest.dataShards + manifest.parityShards).fill(null);
            objects.forEach((object, index) => { shards[object.index] = records[index]!.piece; });
            const directData = Array.from({ length: manifest.dataShards }, (_, index) => shards[index]).every(Boolean);
            encrypted = directData ? concatBytes(shards.slice(0, manifest.dataShards) as Uint8Array[], first.encryptedLength) : await this.erasure.decode(shards, manifest.dataShards, manifest.parityShards, first.encryptedLength);
            const compressed = await decryptFrame(key!, prefix, manifest.fileId, manifest.originalSize, frame, first.originalLength, encrypted);
            encrypted.fill(0); encrypted = undefined;
            try {
              const plaintext = await this.compression.decompress(compressed);
              if (plaintext.byteLength !== first.originalLength) { plaintext.fill(0); throw new Error("Chunk decompression length does not match authenticated frame metadata"); }
              return plaintext;
            } finally { compressed.fill(0); }
          } finally {
            encrypted?.fill(0);
            records.forEach((record) => record.piece.fill(0));
          }
        };

        if (readers.length) {
          try { return await attempt(selected, readers); }
          catch (error) { failure = error; await this.closeReaders(readers); readers = []; selected = []; }
        }
        for (const objects of combinations(available, manifest.dataShards)) {
          let candidateReaders: RecordReader[] = [];
          try {
            candidateReaders = await this.openReaders(objects, frameStart);
            const plaintext = await attempt(objects, candidateReaders);
            readers = candidateReaders; selected = objects;
            return plaintext;
          } catch (error) { failure = error; await this.closeReaders(candidateReaders); }
        }
        const detail = failure instanceof Error ? failure.message : "no valid shard combination";
        throw new Error(`Unable to reconstruct frame ${frame}: ${detail}`);
      };

      for (let index = 0; index < manifest.chunkCount; index += 1) {
        const plaintext = await readFrame(index, readers[0]?.offset ?? 0);
        try { written += plaintext.byteLength; originalHash.update(plaintext); if (isFileSink(output)) await output.write(plaintext); else await output(plaintext); }
        finally { plaintext.fill(0); }
      }
      await Promise.all(readers.map((reader) => reader.finish()));
      if (written !== manifest.originalSize || originalHash.hex() !== manifest.plaintextHash) throw new Error("Restored file failed integrity verification");
      if (isFileSink(output)) await output.close();
    } catch (error) {
      if (isFileSink(output)) await output.abort(error).catch(() => {});
      throw error;
    } finally { await this.closeReaders(readers); await this.storage.close?.(); key?.fill(0); }
  }

  private async retrieveShares(manifest: ChunkedManifest) {
    const shares: Uint8Array[] = [];
    const controller = new AbortController();
    const pending = new Map(manifest.objects.filter((item) => item.kind === "key-share").map((object, index) => [index, this.storage.getShard(object.nodeId, object.objectId, controller.signal).then((share) => ({ index, object, share })).catch(() => ({ index, object }))]));
    while (pending.size && shares.length < manifest.keyShareThreshold) {
      const result = await Promise.race(pending.values()); pending.delete(result.index);
      if ("share" in result && new Sha256Stream().update(result.share).hex() === result.object.checksum) shares.push(result.share);
    }
    controller.abort();
    if (shares.length >= manifest.keyShareThreshold) return shares;
    shares.forEach((share) => share.fill(0)); throw new Error(`Insufficient Shamir shares: need ${manifest.keyShareThreshold}`);
  }

  private async openReader(object: ObjectPlacement, start = 0) {
    return new RecordReader(await this.storage.getShardStream!(object.nodeId, object.objectId, undefined, start), start === 0 ? object.checksum : undefined, start);
  }

  private async openReaders(objects: ObjectPlacement[], start: number) {
    const opened = await Promise.allSettled(objects.map((object) => this.openReader(object, start)));
    const failure = opened.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") { await this.closeReaders(opened.flatMap((result) => result.status === "fulfilled" ? [result.value] : [])); throw failure.reason; }
    return opened.map((result) => (result as PromiseFulfilledResult<RecordReader>).value);
  }

  private async closeReaders(readers: RecordReader[]) { await Promise.allSettled(readers.map((reader) => reader.cancel())); }

  private async *stripes(input: ChunkedUploadInput, config: ChunkedConfig, key: Uint8Array, noncePrefix: Uint8Array): AsyncGenerator<Uint8Array[]> {
    let index = 0;
    for await (const plaintext of fixedChunks(input.source(), CHUNKED_PLAINTEXT_BYTES)) {
      if (index >= 0x1_0000_0000) throw new Error("Chunk counter overflow");
      const compressed = await this.compression.compress(plaintext); const encrypted = await encryptFrame(this.encryption, key, noncePrefix, input.fileId, input.size, index, plaintext.byteLength, compressed); compressed.fill(0);
      const encoded = await this.erasure.encode(encrypted, config.dataShards, config.parityShards); encrypted.fill(0);
      const header = recordHeader(index, plaintext.byteLength, encoded.originalLength, encoded.shardSize);
      yield encoded.shards.map((piece) => concatBytes([header, piece]));
      // Stripe views remain owned by transport consumers until their next pull; do not
      // zero them here, otherwise a queued streaming body can observe mutated bytes.
      plaintext.fill(0); index += 1;
    }
  }
}

/** One generated stripe is retained only until all five PUT streams have consumed it. */
class StripeFanout {
  private current?: Uint8Array[]; private complete = false; private aborted = false; private failure: unknown; private readonly taken = new Set<number>(); private producing?: Promise<void>;
  constructor(private readonly source: AsyncIterator<Uint8Array[]>, private readonly consumers: number) {}
  async *stream(index: number): AsyncGenerator<Uint8Array> { while (true) { const stripe = await this.take(index); if (!stripe) return; yield stripe; } }
  abort(error: unknown) { if (this.aborted) return; this.aborted = true; this.failure = error; this.current = undefined; void this.source.return?.().catch(() => {}); }
  private async take(index: number): Promise<Uint8Array | undefined> {
    if (this.aborted) throw this.failure;
    while (this.current && this.taken.has(index)) { await new Promise<void>((resolve) => setTimeout(resolve, 0)); if (this.aborted) throw this.failure; }
    if (!this.current && !this.complete) await this.produce();
    if (this.aborted) throw this.failure;
    if (!this.current) return undefined;
    const stripe = this.current[index]!; this.taken.add(index);
    if (this.taken.size === this.consumers) { this.current = undefined; this.taken.clear(); }
    return stripe;
  }
  private async produce() {
    if (!this.producing) this.producing = (async () => { const next = await this.source.next(); if (this.aborted || next.done) this.complete = true; else this.current = next.value; this.producing = undefined; })();
    await this.producing;
  }
}

async function decryptFrame(key: Uint8Array, prefix: Uint8Array, fileId: string, originalSize: number, index: number, originalLength: number, encrypted: Uint8Array) {
  try { const cryptoKey = await crypto.subtle.importKey("raw", asWebCryptoBytes(key), "AES-GCM", false, ["decrypt"]); return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: asWebCryptoBytes(nonceFor(prefix, index)), additionalData: asWebCryptoBytes(frameAad(fileId, originalSize, index, originalLength)), tagLength: 128 }, cryptoKey, asWebCryptoBytes(encrypted))); } catch { throw new Error("Chunk decryption failed: frame authentication is invalid"); }
}

class RecordReader {
  private readonly iterator: AsyncIterator<Uint8Array>; private pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0); private readonly hash = new Sha256Stream(); private cancelled = false;
  constructor(source: ByteStream, private readonly checksum?: string, readonly start = 0) { this.iterator = source[Symbol.asyncIterator](); this.offset = start; }
  offset: number;
  async next() {
    const header = await this.read(RECORD_HEADER_BYTES); if (header[0] !== 0x48 || header[1] !== 0x52 || header[2] !== 0x53 || header[3] !== 0x32) throw new Error("Invalid striped record header");
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength); const index = view.getUint32(4); const originalLength = view.getUint32(8); const encryptedLength = view.getUint32(12); const shardSize = view.getUint32(16); return { index, originalLength, encryptedLength, shardSize, piece: await this.read(shardSize) };
  }
  async finish() { let extra = await this.iterator.next(); while (!extra.done) { if (extra.value.byteLength) throw new Error("Stored shard has bytes after its final record"); this.hash.update(extra.value); extra = await this.iterator.next(); } if (this.pending.byteLength || (this.checksum && this.hash.hex() !== this.checksum)) throw new Error("Stored shard checksum failed integrity verification"); }
  async cancel() { if (this.cancelled) return; this.cancelled = true; this.pending.fill(0); this.pending = new Uint8Array(0); await this.iterator.return?.(); }
  private async read(length: number) { if (this.cancelled) throw new Error("Stored shard reader was cancelled"); while (this.pending.byteLength < length) { const next = await this.iterator.next(); if (next.done) throw new Error("Stored shard ended before record boundary"); this.hash.update(next.value); this.pending = this.pending.byteLength ? concatBytes([this.pending, next.value]) : next.value; } const result = this.pending.slice(0, length); this.pending = this.pending.slice(length); this.offset += length; return result; }
}

function* combinations<T>(items: T[], count: number, start = 0, selected: T[] = []): Generator<T[]> {
  if (selected.length === count) { yield selected; return; }
  for (let index = start; index <= items.length - (count - selected.length); index += 1) yield* combinations(items, count, index + 1, [...selected, items[index]!]);
}

async function encryptFrame(_encryption: EncryptionProvider, key: Uint8Array, prefix: Uint8Array, fileId: string, originalSize: number, index: number, originalLength: number, compressed: Uint8Array) {
  const nonce = nonceFor(prefix, index); const cryptoKey = await crypto.subtle.importKey("raw", asWebCryptoBytes(key), "AES-GCM", false, ["encrypt"]); const aad = frameAad(fileId, originalSize, index, originalLength); return new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: asWebCryptoBytes(nonce), additionalData: asWebCryptoBytes(aad), tagLength: 128 }, cryptoKey, asWebCryptoBytes(compressed)));
}
function nonceFor(prefix: Uint8Array, index: number) { const nonce = new Uint8Array(12); nonce.set(prefix); new DataView(nonce.buffer).setUint32(8, index); return nonce; }
function frameAad(fileId: string, originalSize: number, index: number, originalLength: number) { return encoder.encode(`${CHUNKED_FORMAT_VERSION}:${fileId}:${originalSize}:${index}:${originalLength}`); }
function recordHeader(index: number, originalLength: number, encryptedLength: number, shardSize: number) { const bytes = new Uint8Array(RECORD_HEADER_BYTES); bytes.set([0x48, 0x52, 0x53, 0x32]); const view = new DataView(bytes.buffer); view.setUint32(4, index); view.setUint32(8, originalLength); view.setUint32(12, encryptedLength); view.setUint32(16, shardSize); return bytes; }

// zstd's incompressible expansion is bounded per input frame. This deliberately
// grants each node only its largest possible RS piece, never an unbounded file.
function shardMaximumSize(sourceSize: number, dataShards: number) {
  const frames = Math.ceil(sourceSize / CHUNKED_PLAINTEXT_BYTES);
  const compressedBound = sourceSize + Math.ceil(sourceSize / 256) + frames * 512;
  return Math.max(1, Math.ceil((compressedBound + frames * 16) / dataShards) + frames * RECORD_HEADER_BYTES);
}

async function hashSource(source: ByteStream) { const hash = new Sha256Stream(); for await (const chunk of source) hash.update(chunk); return hash.hex(); }
async function* fixedChunks(source: ByteStream, size: number): AsyncGenerator<Uint8Array> { let pending = new Uint8Array(0); for await (const incoming of source) { let bytes = pending.byteLength ? concatBytes([pending, incoming]) : incoming; let offset = 0; while (offset + size <= bytes.byteLength) { yield bytes.slice(offset, offset + size); offset += size; } pending = bytes.slice(offset); if (bytes !== incoming) bytes.fill(0); } if (pending.byteLength || size === 0) yield pending; }
