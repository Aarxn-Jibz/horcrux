import { useEffect, useState } from "react";
import type { StorageNodeContract } from "@horcrux-file-system/shared";
import { listDevices } from "../lib/api";
import { mockStorage } from "../lib/pipeline";
import { formatBytes } from "./FileList";

function capacityPercent(node: StorageNodeContract) {
  if (node.storageCapacity === 0) return 0;
  return Math.min(100, Math.round(node.storageUsed / node.storageCapacity * 100));
}

export function MockNetwork() {
  const [nodes, setNodes] = useState<StorageNodeContract[]>([]);
  const [offline, setOffline] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");

  useEffect(() => {
    listDevices().then(setNodes).catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load devices"));
  }, []);

  function toggle(id: string) {
    setOffline((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      mockStorage.setNodeAvailable(id, !next.has(id));
      return next;
    });
  }

  return (
    <>
      <div className="development-notice"><strong>Development simulation</strong><span>These are IndexedDB partitions in this browser, not physical laptops.</span></div>
      {error && <p className="error" role="alert">{error}</p>}
      <section className="data-panel" aria-label="Storage devices">
        <table className="data-table device-table">
          <thead><tr><th>Device</th><th>State</th><th>Storage</th><th>Health</th><th>Last seen</th><th>Version</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {nodes.map((node) => {
              const isOffline = offline.has(node.id);
              const used = capacityPercent(node);
              return (
                <tr key={node.id}>
                  <td><div className="device-name"><span className="device-glyph" aria-hidden="true" /><span><strong>{node.name}</strong><small>Browser mock</small></span></div></td>
                  <td><span className={`status ${isOffline ? "status-offline" : "status-available"}`}><span className="status-dot" />{isOffline ? "Offline" : "Online"}</span></td>
                  <td><div className="capacity"><span>{formatBytes(node.storageUsed)} / {formatBytes(node.storageCapacity)}</span><span className="capacity-track"><span style={{ width: `${used}%` }} /></span></div></td>
                  <td>{isOffline ? "Unavailable" : "Healthy"}</td>
                  <td>{isOffline ? "—" : "Just now"}</td>
                  <td className="mono">mock</td>
                  <td><button className="secondary node-toggle" onClick={() => toggle(node.id)}>{isOffline ? "Bring online" : "Take offline"}</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </>
  );
}
