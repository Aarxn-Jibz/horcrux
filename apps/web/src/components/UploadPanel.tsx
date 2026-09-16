import { useRef, useState } from "react";
import { DEFAULT_PIPELINE } from "@horcrux-file-system/shared";
import { Sha256Stream, sha256, type PipelineProgressDetail, type PipelineStage } from "@horcrux-file-system/core";
import { completeFile, deleteFile, getFile, initializeFile, updateUploadState } from "../lib/api";
import { createChunkedFilePipeline, createFilePipeline, storageMode } from "../lib/pipeline";
import { formatBytes } from "./FileList";
import { ProgressSteps, TimingSummary } from "./ProgressSteps";
import { OperationError } from "./OperationError";
import { describeError, type DisplayError } from "../lib/errors";

export function UploadPanel({ onComplete }: { onComplete(): void }) {
  const details = useRef<HTMLDetailsElement>(null);
  const [file, setFile] = useState<File>();
  const [stage, setStage] = useState<PipelineStage | "saving">();
  const [timing, setTiming] = useState<PipelineProgressDetail>();
  const [error, setError] = useState<DisplayError>();

  async function upload() {
    if (!file) return;
    if (storageMode === "mock" && file.size > DEFAULT_PIPELINE.maxFileBytes) {
      setError({ message: "This browser pipeline currently supports files up to 256 MiB." });
      return;
    }
    setError(undefined);
    setTiming(undefined);
    const fileId = crypto.randomUUID();
    try {
      setStage("preparing");
      const bytes = storageMode === "mock" ? new Uint8Array(await file.arrayBuffer()) : undefined;
      const plaintextHash = bytes ? await sha256(bytes) : await hashFile(file);
      setFile(undefined);
      const initialized = await initializeFile({ fileId, originalName: file.name, mimeType: file.type || "application/octet-stream", originalSize: file.size, plaintextHash, dataShards: DEFAULT_PIPELINE.dataShards, parityShards: DEFAULT_PIPELINE.parityShards, keyShareThreshold: DEFAULT_PIPELINE.keyThreshold, keyShareCount: DEFAULT_PIPELINE.keyShares, storageMode, ...(storageMode !== "mock" ? { formatVersion: 2 } : {}) });
      const endpoints = new Map(initialized.nodes.flatMap((node) => node.endpoint ? [[node.id, node.endpoint] as const] : []));
      await updateUploadState(fileId, "distributing");
      const manifest = storageMode !== "mock"
        ? await createChunkedFilePipeline(endpoints, storageMode).upload({ fileId, name: file.name, mimeType: file.type, size: file.size, source: () => fileStream(file), plaintextHash }, DEFAULT_PIPELINE, initialized.nodes.map((node) => node.id))
        : await createFilePipeline(storageMode, endpoints).upload({ fileId, name: file.name, mimeType: file.type, bytes: bytes!, plaintextHash }, DEFAULT_PIPELINE, initialized.nodes.map((node) => node.id), (nextStage, detail) => { setStage(nextStage); setTiming(detail); });
      setStage("saving");
      try {
        await completeFile(fileId, manifest);
      } catch (cause) {
        const current = await getFile(fileId).catch(() => null);
        if (current?.status !== "available") throw cause;
      }
      setStage("complete");
      setFile(undefined);
      onComplete();
      details.current?.removeAttribute("open");
      setStage(undefined);
    } catch (cause) {
      await updateUploadState(fileId, "aborted").catch(() => {});
      await deleteFile(fileId).catch(() => {});
      setError(describeError(cause, "Upload failed"));
      setStage(undefined);
    }
  }

  return (
    <details className="upload-menu" ref={details}>
      <summary className="primary">Upload file</summary>
      <section className="upload-popover">
        <div className="popover-heading"><h2>Upload file</h2><p>Secured locally before distribution.</p></div>
        <label className="drop-zone">
          <input type="file" onChange={(event) => setFile(event.target.files?.[0])} disabled={Boolean(stage)} />
          <strong>{file?.name ?? "Choose a file"}</strong>
          <span>{file ? formatBytes(file.size) : "Maximum 256 MiB"}</span>
        </label>
        {stage && <ProgressSteps current={stage} />}
        <details className="advanced-details transfer-details"><summary>Advanced details</summary><p>Mode: {storageMode === "http" ? "enrolled HTTP nodes" : "browser mock"} · zstd level 3 · AES-256-GCM · RS 3+2 · Shamir 3-of-5{stage ? ` · Active: ${stage.replace("-", " ")}` : ""}</p><TimingSummary detail={timing} /></details>
        {error && <OperationError error={error} />}
        <button className="primary upload-submit" disabled={!file || Boolean(stage)} onClick={upload}>Secure and distribute</button>
      </section>
    </details>
  );
}

async function hashFile(file: File) { const hash = new Sha256Stream(); for await (const chunk of fileStream(file)) hash.update(chunk); return hash.hex(); }
async function* fileStream(file: File): AsyncGenerator<Uint8Array> { const reader = file.stream().getReader(); try { while (true) { const next = await reader.read(); if (next.done) return; yield next.value; } } finally { reader.releaseLock(); } }
