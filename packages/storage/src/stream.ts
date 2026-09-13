import type { ByteStream } from "./index";

/** Mock-only collector; HTTP transports keep v2 data streaming end-to-end. */
export async function concat(source: ByteStream, size?: number) {
  const output = new Uint8Array(size ?? 0); let offset = 0; const chunks: Uint8Array[] = [];
  for await (const chunk of source) {
    if (size !== undefined) { output.set(chunk, offset); offset += chunk.byteLength; }
    else chunks.push(chunk);
  }
  if (size !== undefined) { if (offset !== size) throw new Error("Stream size did not match declaration"); return output; }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0); const joined = new Uint8Array(total); offset = 0; for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; } return joined;
}
