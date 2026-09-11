import type { FileSummary } from "@horcrux-file-system/shared";

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}

export function FileList({ files, selected, onSelect }: { files: FileSummary[]; selected?: string; onSelect(id: string): void }) {
  if (files.length === 0) {
    return (
      <section className="data-panel empty-state">
        <div className="empty-file-icon" aria-hidden="true">◇</div>
        <h2>No files yet</h2>
        <p>Select Upload file to secure your first file.</p>
      </section>
    );
  }

  return (
    <section className="data-panel" aria-label="Files">
      <table className="data-table file-table">
        <thead><tr><th>Name</th><th>Size</th><th>Protection</th><th>Created</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>
          {files.map((file) => (
            <tr key={file.fileId} className={selected === file.fileId ? "selected" : ""}>
              <td><button className="file-name-button" onClick={() => onSelect(file.fileId)}><span className="file-glyph" aria-hidden="true" /><span>{file.originalName}</span></button></td>
              <td className="tabular">{formatBytes(file.originalSize)}</td>
              <td>{file.dataShards}+{file.parityShards} shards · {file.keyShareThreshold}/{file.keyShareCount} key</td>
              <td><time dateTime={file.createdAt}>{formatDate(file.createdAt)}</time></td>
              <td><span className={`status status-${file.status}`}><span className="status-dot" />{file.status}</span></td>
              <td><button className="row-action" aria-label={`Open details for ${file.originalName}`} onClick={() => onSelect(file.fileId)}>•••</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
