import { describe, expect, test } from "bun:test";
import { MemoryShardTransport } from "@ciphermesh/storage";
import { BrowserFilePipeline, AuditedShamirProvider, WasmReedSolomonProvider, WebCryptoAesGcm, ZstdCompressionProvider, sha256 } from "./index";

const nodes = ["a", "b", "c", "d", "e"];
function setup() { const storage = new MemoryShardTransport(nodes); return { storage, pipeline: new BrowserFilePipeline(new ZstdCompressionProvider(), new WebCryptoAesGcm(), new WasmReedSolomonProvider(), new AuditedShamirProvider(), storage) }; }

describe("complete browser pipeline", () => {
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

  test("rolls back objects after a partial distribution failure", async () => {
    const { storage, pipeline } = setup(); storage.setNodeAvailable("b", false);
    await expect(pipeline.upload({ fileId: crypto.randomUUID(), name: "partial.txt", mimeType: "text/plain", bytes: new Uint8Array([1, 2, 3]) }, { dataShards: 3, parityShards: 2, keyShares: 5, keyThreshold: 3 }, nodes)).rejects.toThrow("unavailable");
    expect(storage.objectCount).toBe(0);
  });
});
