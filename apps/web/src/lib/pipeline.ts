import reedSolomonWasmUrl from "@subspace/reed-solomon-erasure.wasm/dist/reed_solomon_erasure_bg.wasm?url";
import { AuditedShamirProvider, BrowserFilePipeline, ChunkedFilePipeline, WasmReedSolomonProvider, WebCryptoAesGcm, ZstdCompressionProvider, reedSolomonFromResponse } from "@horcrux-file-system/core";
import { HttpShardTransport, IndexedDbShardTransport, WebRtcShardTransport, type ShardTransport } from "@horcrux-file-system/storage";
import { HorcruxPeer } from "./webrtc-peer";
import { MOCK_NODE_IDS } from "@horcrux-file-system/shared";
import { requestNodeCapability, submitNodeReceipt } from "./api";

export type StorageMode = "mock" | "http" | "webrtc";
export const storageMode: StorageMode = import.meta.env.VITE_HORCRUX_STORAGE_MODE === "webrtc" ? "webrtc" : import.meta.env.VITE_HORCRUX_STORAGE_MODE === "http" ? "http" : "mock";
export const mockStorage = new IndexedDbShardTransport(MOCK_NODE_IDS);

function createPipeline(storage: ShardTransport) {
  return new BrowserFilePipeline(
    new ZstdCompressionProvider(),
    new WebCryptoAesGcm(),
    new WasmReedSolomonProvider(() => reedSolomonFromResponse(fetch(reedSolomonWasmUrl))),
    new AuditedShamirProvider(),
    storage,
  );
}

export function createStorageTransport(mode: StorageMode, endpoints: Map<string, string> = new Map()): ShardTransport {
  if (mode === "mock") return mockStorage;
  if (mode === "webrtc") return new WebRtcShardTransport(
    async (nodeId) => HorcruxPeer.connect(nodeId),
    requestNodeCapability,
    async (receipt) => { await submitNodeReceipt(receipt); },
  );
  return new HttpShardTransport({
    resolveEndpoint: (nodeId) => {
      const endpoint = endpoints.get(nodeId);
      if (!endpoint) throw new Error(`No browser-reachable endpoint is registered for storage node ${nodeId}`);
      return endpoint;
    },
    requestCapability: requestNodeCapability,
    submitReceipt: async (receipt) => { await submitNodeReceipt(receipt); },
  });
}

export function createFilePipeline(mode: StorageMode, endpoints: Map<string, string> = new Map()) {
  return createPipeline(createStorageTransport(mode, endpoints));
}

export function createChunkedFilePipeline(endpoints: Map<string, string>, mode: StorageMode = "http") {
  return new ChunkedFilePipeline(
    new ZstdCompressionProvider(), new WebCryptoAesGcm(), new WasmReedSolomonProvider(() => reedSolomonFromResponse(fetch(reedSolomonWasmUrl))), new AuditedShamirProvider(), createStorageTransport(mode, endpoints),
  );
}
