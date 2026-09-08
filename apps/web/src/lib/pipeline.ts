import reedSolomonWasmUrl from "@subspace/reed-solomon-erasure.wasm/dist/reed_solomon_erasure_bg.wasm?url";
import { AuditedShamirProvider, BrowserFilePipeline, WasmReedSolomonProvider, WebCryptoAesGcm, ZstdCompressionProvider, reedSolomonFromResponse } from "@ciphermesh/core";
import { IndexedDbShardTransport } from "@ciphermesh/storage";
import { MOCK_NODE_IDS } from "@ciphermesh/shared";

export const mockStorage = new IndexedDbShardTransport(MOCK_NODE_IDS);
export const filePipeline = new BrowserFilePipeline(new ZstdCompressionProvider(), new WebCryptoAesGcm(), new WasmReedSolomonProvider(() => reedSolomonFromResponse(fetch(reedSolomonWasmUrl))), new AuditedShamirProvider(), mockStorage);
