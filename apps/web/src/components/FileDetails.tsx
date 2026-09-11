import { useEffect, useState } from "react";
import type { FileSummary } from "@horcrux-file-system/shared";
import type { PipelineProgressDetail, PipelineStage } from "@horcrux-file-system/core";
import { deleteFile, downloadManifest, getFile } from "../lib/api";
import { filePipeline, mockStorage } from "../lib/pipeline";
import { formatBytes } from "./FileList";
import { ProgressSteps, TimingSummary } from "./ProgressSteps";
import { OperationError } from "./OperationError";
import { describeError, type DisplayError } from "../lib/errors";

type DetailedFile = FileSummary & { objects: unknown[] };

export function FileDetails({ fileId, onChanged, onClose }: { fileId: string; onChanged(): void; onClose(): void }) {
  const [file, setFile] = useState<DetailedFile>();
  const [error, setError] = useState<DisplayError>();
  const [stage, setStage] = useState<PipelineStage>();
  const [timing, setTiming] = useState<PipelineProgressDetail>();

  useEffect(() => {
    setFile(undefined);
    setError(undefined);
    setTiming(undefined);
    getFile(fileId).then(setFile).catch((cause) => setError(describeError(cause, "Could not load file")));
  }, [fileId]);

  async function download() {
    setError(undefined);
    try {
      setStage("locating");
      const manifest = await downloadManifest(fileId);
      const bytes = await filePipeline.download(manifest, (nextStage, detail) => { setStage(nextStage); setTiming(detail); });
      const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: manifest.mimeType }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = manifest.originalName;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      setError(describeError(cause, "Reconstruction failed"));
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
          <details className="advanced-details"><summary>Advanced details</summary><p>Compression: {file.compressionAlgorithm} · Ciphertext: {formatBytes(file.encryptedSize)} · Client-side authenticated encryption</p><TimingSummary detail={timing} /></details>
          {stage && <ProgressSteps current={stage} flow="download" />}
          {error && <OperationError error={error} />}
          <div className="actions"><button className="primary" disabled={file.status !== "available" || Boolean(stage)} onClick={download}>Download</button><button className="danger" disabled={Boolean(stage)} onClick={remove}>Delete file</button></div>
        </>
      )}
      {!file && error && <OperationError error={error} />}
    </aside>
  );
}
