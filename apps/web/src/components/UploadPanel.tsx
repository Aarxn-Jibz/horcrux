import { useRef, useState } from "react";
import { DEFAULT_PIPELINE } from "@horcrux-file-system/shared";
import { sha256, type PipelineStage } from "@horcrux-file-system/core";
import { completeFile, deleteFile, initializeFile, updateUploadState } from "../lib/api";
import { filePipeline } from "../lib/pipeline";
import { formatBytes } from "./FileList";
import { ProgressSteps } from "./ProgressSteps";

export function UploadPanel({ onComplete }: { onComplete(): void }) {
  const details = useRef<HTMLDetailsElement>(null);
  const [file, setFile] = useState<File>();
  const [stage, setStage] = useState<PipelineStage | "saving">();
  const [error, setError] = useState("");

  async function upload() {
    if (!file) return;
    if (file.size > DEFAULT_PIPELINE.maxFileBytes) {
      setError("This browser pipeline currently supports files up to 256 MiB.");
      return;
    }
    setError("");
    const fileId = crypto.randomUUID();
    try {
      setStage("preparing");
      const bytes = new Uint8Array(await file.arrayBuffer());
      const plaintextHash = await sha256(bytes);
      const initialized = await initializeFile({ fileId, originalName: file.name, mimeType: file.type || "application/octet-stream", originalSize: file.size, plaintextHash, dataShards: DEFAULT_PIPELINE.dataShards, parityShards: DEFAULT_PIPELINE.parityShards, keyShareThreshold: DEFAULT_PIPELINE.keyThreshold, keyShareCount: DEFAULT_PIPELINE.keyShares });
      await updateUploadState(fileId, "distributing");
      const manifest = await filePipeline.upload({ fileId, name: file.name, mimeType: file.type, bytes }, DEFAULT_PIPELINE, initialized.nodes.map((node) => node.id), setStage);
      setStage("saving");
      await completeFile(fileId, manifest);
      setStage("complete");
      setFile(undefined);
      onComplete();
      details.current?.removeAttribute("open");
      setStage(undefined);
    } catch (cause) {
      await updateUploadState(fileId, "aborted").catch(() => {});
      await deleteFile(fileId).catch(() => {});
      setError(cause instanceof Error ? cause.message : "Upload failed");
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
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary upload-submit" disabled={!file || Boolean(stage)} onClick={upload}>Secure and distribute</button>
      </section>
    </details>
  );
}
