import { useEffect, useState } from "react";
import type { FileSummary } from "@horcrux-file-system/shared";
import type { PipelineStage } from "@horcrux-file-system/core";
import { deleteFile, downloadManifest, getFile } from "../lib/api";
import { filePipeline, mockStorage } from "../lib/pipeline";
import { formatBytes } from "./FileList";

type DetailedFile = FileSummary & { objects: unknown[] };

export function FileDetails({ fileId, onChanged, onClose }: { fileId: string; onChanged(): void; onClose(): void }) {
  const [file, setFile] = useState<DetailedFile>();
  const [error, setError] = useState("");
  const [stage, setStage] = useState<PipelineStage>();

  useEffect(() => {
    setFile(undefined);
    setError("");
    getFile(fileId).then(setFile).catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load file"));
  }, [fileId]);

  async function download() {
    setError("");
    try {
      const manifest = await downloadManifest(fileId);
      const bytes = await filePipeline.download(manifest, setStage);
      const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: manifest.mimeType }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = manifest.originalName;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Reconstruction failed");
    } finally {
      setStage(undefined);
    }
  }

  async function remove() {
    if (!confirm("Delete this file and its local mock objects?")) return;
    const manifest = await downloadManifest(fileId).catch(() => null);
    if (manifest) await Promise.allSettled(manifest.objects.map((item) => mockStorage.deleteShard(item.nodeId, item.objectId)));
    await deleteFile(fileId);
    onClose();
    onChanged();
  }

  return (
    <aside className="details-drawer" aria-live="polite">
      <div className="drawer-heading">
        <div><p className="eyebrow">File details</p><h2>{file?.originalName ?? "Loading…"}</h2></div>
        <button className="row-action drawer-close" aria-label="Close file details" onClick={onClose}>×</button>
      </div>
      {file && (
        <>
          <dl className="detail-list">
            <div><dt>Size</dt><dd>{formatBytes(file.originalSize)}</dd></div>
            <div><dt>Status</dt><dd className="capitalize">{file.status}</dd></div>
            <div><dt>Protection</dt><dd>{file.dataShards}+{file.parityShards} RS · {file.keyShareThreshold}/{file.keyShareCount} key shares</dd></div>
            <div><dt>Encryption</dt><dd>{file.encryptionAlgorithm}</dd></div>
            <div><dt>Stored objects</dt><dd>{file.objects.length} mock objects</dd></div>
          </dl>
          <details className="advanced-details"><summary>Advanced details</summary><p>Compression: {file.compressionAlgorithm} · Ciphertext: {formatBytes(file.encryptedSize)} · Client-side authenticated encryption</p></details>
          {stage && <p className="working">Retrieving file: {stage.replace("-", " ")}…</p>}
          {error && <p className="error" role="alert">{error}</p>}
          <div className="actions"><button className="primary" disabled={file.status !== "available" || Boolean(stage)} onClick={download}>Download</button><button className="danger" disabled={Boolean(stage)} onClick={remove}>Delete file</button></div>
        </>
      )}
      {!file && error && <p className="error" role="alert">{error}</p>}
    </aside>
  );
}
