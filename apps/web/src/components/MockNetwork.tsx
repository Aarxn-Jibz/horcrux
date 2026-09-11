import { useEffect, useState } from "react";
import type { StorageNodeContract } from "@horcrux-file-system/shared";
import { listDevices } from "../lib/api";
import { mockStorage } from "../lib/pipeline";
import { formatBytes } from "./FileList";

function capacityPercent(node: StorageNodeContract) {
  if (node.storageCapacity === 0) return 0;
  return Math.min(100, Math.round(node.storageUsed / node.storageCapacity * 100));
}

function relativeLastSeen(value: string | null, isMock: boolean) {
  if (isMock) return "This session";
  if (!value) return "Never";
  const timestamp = Date.parse(`${value.replace(" ", "T")}Z`);
  if (!Number.isFinite(timestamp)) return "Unknown";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

export function MockNetwork() {
  const [nodes, setNodes] = useState<StorageNodeContract[]>([]);
  const [offline, setOffline] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");

  useEffect(() => {
    listDevices().then(setNodes).catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load devices"));
  }, []);

  function toggle(id: string) {
    if (nodes.find((node) => node.id === id)?.kind === "laptop") return;
    setOffline((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      mockStorage.setNodeAvailable(id, !next.has(id));
      return next;
    });
  }

  return (
    <>
      {nodes.some((node) => node.kind !== "laptop") && (
        <div className="development-notice"><strong>Development simulation</strong><span>Rows marked Browser mock are IndexedDB partitions in this browser, not physical laptops.</span></div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <section className="data-panel" aria-label="Storage devices">
        <table className="data-table device-table">
          <thead><tr><th>Device</th><th>State</th><th>Storage</th><th>Health</th><th>Last seen</th><th>Version</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {nodes.map((node) => {
              const isMock = node.kind !== "laptop";
              const simulatedOffline = isMock && offline.has(node.id);
              const state = simulatedOffline ? "offline" : node.status;
              const isOffline = state === "offline" || state === "disabled";
              const used = capacityPercent(node);
              return (
                <tr key={node.id}>
                  <td><div className="device-name"><span className="device-glyph" aria-hidden="true" /><span><strong>{node.name}</strong><small>{isMock ? "Browser mock" : "Laptop node"}</small></span></div></td>
                  <td><span className={`status status-${isOffline ? "offline" : state}`}><span className="status-dot" />{isOffline ? "Offline" : state}</span></td>
                  <td><div className="capacity"><span>{formatBytes(node.storageUsed)} / {formatBytes(node.storageCapacity)}</span><span className="capacity-track"><span style={{ width: `${used}%` }} /></span></div></td>
                  <td className="capitalize">{simulatedOffline ? "unavailable" : node.health ?? (isOffline ? "unknown" : "healthy")}</td>
                  <td title={node.lastSeen ?? undefined}>{relativeLastSeen(node.lastSeen, isMock)}</td>
                  <td className="mono">{isMock ? "mock" : node.nodeVersion ?? "—"}</td>
                  <td>{isMock ? <button className="secondary node-toggle" onClick={() => toggle(node.id)}>{isOffline ? "Bring online" : "Take offline"}</button> : <span className="muted">—</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </>
  );
}
