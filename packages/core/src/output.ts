/** A destination for bounded reconstruction output. Implementations own finalization. */
export interface FileSink {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

export type ReconstructionOutput = FileSink | ((chunk: Uint8Array) => Promise<void> | void);

export function isFileSink(output: ReconstructionOutput): output is FileSink {
  return typeof output !== "function";
}
