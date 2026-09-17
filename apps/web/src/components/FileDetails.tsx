import { useEffect, useState } from "react";
import type { FileManifest, FileSummary } from "@horcrux-file-system/shared";
import { type ChunkedManifest, type PipelineProgressDetail, type PipelineStage } from "@horcrux-file-system/core";
import { deleteFile, downloadManifest, getFile } from "../lib/api";
import { createChunkedFilePipeline, createFilePipeline, storageMode } from "../lib/pipeline";
import { formatBytes } from "./FileList";
import { ProgressSteps, TimingSummary } from "./ProgressSteps";
import { OperationError } from "./OperationError";
import { describeError, type DisplayError } from "../lib/errors";
import { openDownloadSink } from "../lib/file-sink";

type DetailedFile = FileSummary & { objects: FileManifest["objects"] };

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
      const endpoints = new Map(manifest.objects.flatMap((object) => object.endpoint ? [[object.nodeId, object.endpoint] as const] : []));
      const mode = storageMode;
      if ((manifest as FileManifest & { formatVersion?: number }).formatVersion === 2) {
        const sink = await openDownloadSink(manifest.originalName, manifest.mimeType, manifest.originalSize);
        await createChunkedFilePipeline(endpoints, mode).downloadTo(manifest as unknown as ChunkedManifest, sink);
      } else {
        const bytes = await createFilePipeline(mode, endpoints).download(manifest, (nextStage, detail) => { setStage(nextStage); setTiming(detail); });
        const sink = await openDownloadSink(manifest.originalName, manifest.mimeType, bytes.byteLength);
        await sink.write(bytes); await sink.close();
      }
    } catch (cause) {
      setError(describeError(cause, "Reconstruction failed"));
    } finally {
      setStage(undefined);
    }
  }

  async function remove() {
    if (!confirm("Delete this file and its stored encrypted objects?")) return;
    setError(undefined);
    try {
      await deleteFile(fileId);
      setFile(await getFile(fileId));
      onChanged();
    } catch (cause) {
      setError(describeError(cause, "Could not start deletion"));
    }
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
            <div><dt>Stored objects</dt><dd>{file.objects.length} encrypted objects</dd></div>
          </dl>
          <details className="advanced-details"><summary>Advanced details</summary><p>Compression: {file.compressionAlgorithm} · Ciphertext: {formatBytes(file.encryptedSize)} · Client-side authenticated encryption</p><TimingSummary detail={timing} /></details>
          {stage && <ProgressSteps current={stage} flow="download" />}
          {error && <OperationError error={error} />}
          <div className="actions"><button className="primary" disabled={file.status !== "available" || Boolean(stage)} onClick={download}>Download</button><button className="danger" disabled={file.status === "deleting" || Boolean(stage)} onClick={remove}>Delete file</button></div>
        </>
      )}
      {!file && error && <OperationError error={error} />}
    </aside>
  );
}
