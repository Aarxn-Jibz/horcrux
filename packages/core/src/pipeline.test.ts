import { describe, expect, test } from "bun:test";
import { MemoryShardTransport } from "@horcrux-file-system/storage";
import { DEFAULT_PIPELINE } from "@horcrux-file-system/shared";
import { BrowserFilePipeline, AuditedShamirProvider, WasmReedSolomonProvider, WebCryptoAesGcm, ZstdCompressionProvider, sha256 } from "./index";

const nodes = ["a", "b", "c", "d", "e"];
function setup() { const storage = new MemoryShardTransport(nodes); return { storage, pipeline: new BrowserFilePipeline(new ZstdCompressionProvider(), new WebCryptoAesGcm(), new WasmReedSolomonProvider(), new AuditedShamirProvider(), storage) }; }

class ObservedStorage extends MemoryShardTransport {
  activePuts = 0;
  maximumPuts = 0;

  override async putShard(nodeId: string, objectId: string, bytes: Uint8Array) {
    this.activePuts += 1;
    this.maximumPuts = Math.max(this.maximumPuts, this.activePuts);
    try {
      await new Promise((resolve) => setTimeout(resolve, 4));
      return await super.putShard(nodeId, objectId, bytes);
    } finally {
      this.activePuts -= 1;
    }
  }
}

describe("complete browser pipeline", () => {
  test("stores every shard and key share with exactly four active writes", async () => {
    const storage = new ObservedStorage(nodes);
    const pipeline = new BrowserFilePipeline(new ZstdCompressionProvider(), new WebCryptoAesGcm(), new WasmReedSolomonProvider(), new AuditedShamirProvider(), storage);
    const manifest = await pipeline.upload({ fileId: crypto.randomUUID(), name: "parallel.bin", mimeType: "application/octet-stream", bytes: crypto.getRandomValues(new Uint8Array(4096)) }, DEFAULT_PIPELINE, nodes);

    expect(manifest.objects).toHaveLength(10);
    expect(storage.objectCount).toBe(10);
    expect(storage.maximumPuts).toBeLessThanOrEqual(4);
    expect(storage.maximumPuts).toBe(4);
  });

  test("restores byte-identical content with two nodes unavailable", async () => {
    const { storage, pipeline } = setup(); const bytes = crypto.getRandomValues(new Uint8Array(8192));
    const manifest = await pipeline.upload({ fileId: crypto.randomUUID(), name: "random.bin", mimeType: "application/octet-stream", bytes }, { dataShards: 3, parityShards: 2, keyShares: 5, keyThreshold: 3 }, nodes);
    storage.setNodeAvailable("a", false); storage.setNodeAvailable("b", false);
    const restored = await pipeline.download(manifest);
    expect(await sha256(restored)).toBe(await sha256(bytes)); expect(restored).toEqual(bytes);
  });

  test("fails clearly below the Shamir threshold", async () => {
    const { storage, pipeline } = setup(); const bytes = new TextEncoder().encode("private file");
    const manifest = await pipeline.upload({ fileId: crypto.randomUUID(), name: "private.txt", mimeType: "text/plain", bytes }, { dataShards: 3, parityShards: 2, keyShares: 5, keyThreshold: 3 }, nodes);
    for (const share of manifest.objects.filter((item) => item.kind === "key-share").slice(0, 3)) storage.deleteObject(share.nodeId, share.objectId);
    await expect(pipeline.download(manifest)).rejects.toThrow("Insufficient Shamir shares");
  });

  test("ignores a corrupt shard and recovers with parity", async () => {
    const { storage, pipeline } = setup(); const bytes = crypto.getRandomValues(new Uint8Array(2048));
    const manifest = await pipeline.upload({ fileId: crypto.randomUUID(), name: "corrupt.bin", mimeType: "application/octet-stream", bytes }, { dataShards: 3, parityShards: 2, keyShares: 5, keyThreshold: 3 }, nodes);
    const shard = manifest.objects.find((item) => item.kind === "shard")!; storage.corruptObject(shard.nodeId, shard.objectId);
    expect(await pipeline.download(manifest)).toEqual(bytes);
  });

  test("fails clearly below the Reed-Solomon threshold", async () => {
    const { storage, pipeline } = setup(); const bytes = new Uint8Array([4, 5, 6]);
    const manifest = await pipeline.upload({ fileId: crypto.randomUUID(), name: "missing.bin", mimeType: "application/octet-stream", bytes }, { dataShards: 3, parityShards: 2, keyShares: 5, keyThreshold: 3 }, nodes);
    storage.setNodeAvailable("a", false); storage.setNodeAvailable("b", false); storage.setNodeAvailable("c", false);
    await expect(pipeline.download(manifest)).rejects.toThrow("Insufficient Reed-Solomon shards");
  });

  test("rolls back objects after a partial distribution failure", async () => {
    const { storage, pipeline } = setup(); storage.setNodeAvailable("b", false);
    await expect(pipeline.upload({ fileId: crypto.randomUUID(), name: "partial.txt", mimeType: "text/plain", bytes: new Uint8Array([1, 2, 3]) }, { dataShards: 3, parityShards: 2, keyShares: 5, keyThreshold: 3 }, nodes)).rejects.toThrow("unavailable");
    expect(storage.objectCount).toBe(0);
  });
});
