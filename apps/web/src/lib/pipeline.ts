import reedSolomonWasmUrl from "@subspace/reed-solomon-erasure.wasm/dist/reed_solomon_erasure_bg.wasm?url";
import { AuditedShamirProvider, BrowserFilePipeline, WasmReedSolomonProvider, WebCryptoAesGcm, ZstdCompressionProvider, reedSolomonFromResponse } from "@horcrux-file-system/core";
import { HttpShardTransport, IndexedDbShardTransport, type ShardTransport } from "@horcrux-file-system/storage";
import { MOCK_NODE_IDS } from "@horcrux-file-system/shared";
import { requestNodeCapability, submitNodeReceipt } from "./api";

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

export const filePipeline = createPipeline(mockStorage);

export function createNetworkFilePipeline(resolveEndpoint: (nodeId: string) => string | Promise<string>) {
  return createPipeline(new HttpShardTransport({
    resolveEndpoint,
    requestCapability: requestNodeCapability,
    submitReceipt: async (receipt) => { await submitNodeReceipt(receipt); },
  }));
}
