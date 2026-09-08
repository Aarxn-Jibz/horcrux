import { useEffect, useState } from "react";
import type { StorageNodeContract } from "@ciphermesh/shared";
import { listDevices } from "../lib/api";
import { mockStorage } from "../lib/pipeline";

export function MockNetwork() { const [nodes, setNodes] = useState<StorageNodeContract[]>([]); const [offline, setOffline] = useState<Set<string>>(new Set()); useEffect(() => { listDevices().then(setNodes).catch(() => {}); }, []); function toggle(id: string) { setOffline((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); mockStorage.setNodeAvailable(id, !next.has(id)); return next; }); }
  return <section className="panel network-panel"><div><p className="eyebrow">Development network</p><h2>Mock storage nodes</h2><p className="muted">Take nodes offline to test shard and key-share thresholds.</p></div><div className="node-list">{nodes.map((node) => <button key={node.id} onClick={() => toggle(node.id)} className={offline.has(node.id) ? "offline" : "online"}><span className="node-dot" /><strong>{node.name}</strong><small>{offline.has(node.id) ? "Offline" : "Online"}</small></button>)}</div></section>;
}
