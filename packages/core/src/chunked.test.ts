import { describe, expect, test } from "bun:test";
import { MemoryShardTransport } from "@horcrux-file-system/storage";
import { AuditedShamirProvider, CHUNKED_PLAINTEXT_BYTES, ChunkedFilePipeline, Sha256Stream, WasmReedSolomonProvider, WebCryptoAesGcm, ZstdCompressionProvider } from "./index";

const nodes = ["a", "b", "c", "d", "e"];
function source(bytes: Uint8Array, slice = 65_537) { return async function* () { for (let offset = 0; offset < bytes.byteLength; offset += slice) yield bytes.slice(offset, offset + slice); }; }
function pipeline(storage: MemoryShardTransport) { return new ChunkedFilePipeline(new ZstdCompressionProvider(), new WebCryptoAesGcm(), new WasmReedSolomonProvider(), new AuditedShamirProvider(), storage); }

describe("v2 chunked file format", () => {
  test("reconstructs a stripe from shard indexes 0, 2, and 4", async () => {
    const erasure = new WasmReedSolomonProvider(); const input = generated(CHUNKED_PLAINTEXT_BYTES + 16); const encoded = await erasure.encode(input, 3, 2);
    expect(await erasure.decode([encoded.shards[0]!, null, encoded.shards[2]!, null, encoded.shards[4]!], 3, 2, input.byteLength)).toEqual(input);
  });
  test.each([0, 1, 1024, CHUNKED_PLAINTEXT_BYTES, CHUNKED_PLAINTEXT_BYTES + 1, 9 * CHUNKED_PLAINTEXT_BYTES + 17])("round-trips %i bytes through bounded stripes", async (size) => {
    const storage = new MemoryShardTransport(nodes); const input = generated(size); const fileId = crypto.randomUUID();
    const manifest = await pipeline(storage).upload({ fileId, name: "chunked.bin", mimeType: "application/octet-stream", size, source: source(input) }, { dataShards: 3, parityShards: 2, keyShares: 5, keyThreshold: 3 }, nodes);
    expect(manifest.formatVersion).toBe(2); expect(manifest.chunkCount).toBe(size === 0 ? 0 : Math.ceil(size / CHUNKED_PLAINTEXT_BYTES)); expect(manifest.objects).toHaveLength(10);
    const output: Uint8Array[] = []; await pipeline(storage).downloadTo(manifest, (chunk) => { output.push(chunk.slice()); });
    expect(join(output)).toEqual(input);
  }, 120_000);

  test("uses a unique deterministic nonce position for every chunk and recovers with two nodes down", async () => {
    const storage = new MemoryShardTransport(nodes); const input = generated(9 * CHUNKED_PLAINTEXT_BYTES + 3); const instance = pipeline(storage);
    const manifest = await instance.upload({ fileId: crypto.randomUUID(), name: "recovery.bin", mimeType: "application/octet-stream", size: input.byteLength, source: source(input, 1_000_003) }, { dataShards: 3, parityShards: 2, keyShares: 5, keyThreshold: 3 }, nodes);
    storage.setNodeAvailable("b", false); storage.setNodeAvailable("d", false);
    const output: Uint8Array[] = []; await instance.downloadTo(manifest, (chunk) => { output.push(chunk.slice()); });
    expect(new Sha256Stream().update(join(output)).hex()).toBe(new Sha256Stream().update(input).hex());
  }, 120_000);

  test("replaces a selected shard after it truncates mid-download", async () => {
    const storage = new TruncatingTransport(nodes, "a"); const input = generated(5 * CHUNKED_PLAINTEXT_BYTES + 19); const instance = pipeline(storage);
    const manifest = await instance.upload({ fileId: crypto.randomUUID(), name: "midstream.bin", mimeType: "application/octet-stream", size: input.byteLength, source: source(input) }, { dataShards: 3, parityShards: 2, keyShares: 5, keyThreshold: 3 }, nodes);
    const output: Uint8Array[] = []; await instance.downloadTo(manifest, (chunk) => { output.push(chunk.slice()); });
    expect(storage.resumed).toBeTrue();
    expect(new Sha256Stream().update(join(output)).hex()).toBe(new Sha256Stream().update(input).hex());
  }, 120_000);

  test("closes a streaming sink after verified reconstruction", async () => {
    const storage = new MemoryShardTransport(nodes); const input = generated(CHUNKED_PLAINTEXT_BYTES + 7); const instance = pipeline(storage);
    const manifest = await instance.upload({ fileId: crypto.randomUUID(), name: "sink.bin", mimeType: "application/octet-stream", size: input.byteLength, source: source(input) }, { dataShards: 3, parityShards: 2, keyShares: 5, keyThreshold: 3 }, nodes);
    const output: Uint8Array[] = []; let closed = false; let aborted = false;
    await instance.downloadTo(manifest, { write: async (chunk) => { output.push(chunk.slice()); }, close: async () => { closed = true; }, abort: async () => { aborted = true; } });
    expect(join(output)).toEqual(input); expect(closed).toBeTrue(); expect(aborted).toBeFalse();
  }, 120_000);

  test("fails below three physical nodes", async () => {
    const storage = new MemoryShardTransport(nodes); const input = generated(CHUNKED_PLAINTEXT_BYTES + 7); const instance = pipeline(storage);
    const manifest = await instance.upload({ fileId: crypto.randomUUID(), name: "failure.bin", mimeType: "application/octet-stream", size: input.byteLength, source: source(input) }, { dataShards: 3, parityShards: 2, keyShares: 5, keyThreshold: 3 }, nodes);
    storage.setNodeAvailable("a", false); storage.setNodeAvailable("b", false); storage.setNodeAvailable("c", false);
    await expect(instance.downloadTo(manifest, () => {})).rejects.toThrow("Insufficient Shamir shares");
  }, 120_000);

  test("processes a 32 MiB generated source as 32 bounded frames", async () => {
    const storage = new MemoryShardTransport(nodes); const input = generated(32 * CHUNKED_PLAINTEXT_BYTES); const instance = pipeline(storage);
    const manifest = await instance.upload({ fileId: crypto.randomUUID(), name: "large.bin", mimeType: "application/octet-stream", size: input.byteLength, source: source(input, 131_071) }, { dataShards: 3, parityShards: 2, keyShares: 5, keyThreshold: 3 }, nodes);
    expect(manifest.chunkCount).toBe(32);
    const output: Uint8Array[] = []; await instance.downloadTo(manifest, (chunk) => { output.push(chunk.slice()); });
    expect(new Sha256Stream().update(join(output)).hex()).toBe(new Sha256Stream().update(input).hex());
  }, 180_000);
});

function generated(size: number) { const bytes = new Uint8Array(size); for (let index = 0; index < size; index += 1) bytes[index] = (index * 17 + index >>> 8) & 0xff; return bytes; }
function join(chunks: Uint8Array[]) { const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0); const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; } return bytes; }

class TruncatingTransport extends MemoryShardTransport {
  resumed = false;
  constructor(nodes: readonly string[], private readonly failNode: string) { super(nodes); }
  override async getShardStream(nodeId: string, objectId: string, signal?: AbortSignal, start = 0) {
    const stream = await super.getShardStream(nodeId, objectId, signal, start);
    if (nodeId !== this.failNode || start > 0) { if (start > 0) this.resumed = true; return stream; }
    return (async function* () {
      for await (const bytes of stream) {
        const firstRecord = 20 + new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(16);
        yield bytes.slice(0, firstRecord);
        throw new Error("simulated selected shard connection loss");
      }
    })();
  }
}
