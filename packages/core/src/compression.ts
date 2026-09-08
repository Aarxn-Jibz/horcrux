import { compress, decompress, init } from "@bokuweb/zstd-wasm";
export interface CompressionProvider { readonly algorithm: "zstd"; compress(bytes: Uint8Array): Promise<Uint8Array>; decompress(bytes: Uint8Array): Promise<Uint8Array> }
let initialization: Promise<void> | undefined;
export class ZstdCompressionProvider implements CompressionProvider { readonly algorithm = "zstd" as const; constructor(private readonly level = 3) {} private ready() { return initialization ??= init(); } async compress(bytes: Uint8Array) { await this.ready(); return compress(bytes, this.level); } async decompress(bytes: Uint8Array) { await this.ready(); try { return decompress(bytes); } catch { throw new Error("Decompression failed: restored bytes are invalid"); } } }
