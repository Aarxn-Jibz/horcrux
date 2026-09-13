import type { FileSink } from "@horcrux-file-system/core";

const BLOB_FALLBACK_LIMIT = 100 * 1024 * 1024;
type SavePicker = (options: { suggestedName: string }) => Promise<{ createWritable(): Promise<{ write(data: Uint8Array): Promise<void>; close(): Promise<void>; abort(reason?: unknown): Promise<void> }> }>;

/** Uses the File System Access API when available; Blob fallback is deliberately bounded. */
export async function openDownloadSink(name: string, mimeType: string, size: number): Promise<FileSink> {
  const picker = (globalThis as typeof globalThis & { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  if (picker) {
    const writable = await (await picker({ suggestedName: name })).createWritable();
    return { write: (chunk) => writable.write(chunk), close: () => writable.close(), abort: (reason) => writable.abort(reason) };
  }
  if (size > BLOB_FALLBACK_LIMIT) throw new Error("This browser cannot stream large downloads to disk. Use a browser with native file saving for files over 100 MiB.");
  const chunks: Uint8Array[] = [];
  return {
    async write(chunk) { chunks.push(chunk.slice()); },
    async close() { const url = URL.createObjectURL(new Blob(chunks as Uint8Array<ArrayBuffer>[], { type: mimeType })); const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 0); },
    async abort() { chunks.length = 0; },
  };
}
