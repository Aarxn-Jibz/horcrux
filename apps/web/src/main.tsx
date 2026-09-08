import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { AuthScreen } from "./components/AuthScreen";
import { FileDetails } from "./components/FileDetails";
import { FileList } from "./components/FileList";
import { UploadPanel } from "./components/UploadPanel";
import { MockNetwork } from "./components/MockNetwork";
import { listFiles, logout, refresh, type User } from "./lib/api";
import type { FileSummary } from "@ciphermesh/shared";

function App() {
  const [user, setUser] = useState<User | null>(); const [files, setFiles] = useState<FileSummary[]>([]); const [selected, setSelected] = useState<string>(); const [error, setError] = useState("");
  const reload = useCallback(async () => { try { const next = await listFiles(); setFiles(next); if (selected && !next.some((file) => file.fileId === selected)) setSelected(undefined); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load files"); } }, [selected]);
  useEffect(() => { refresh().then(setUser).catch(() => setUser(null)); }, []);
  useEffect(() => { if (user) void reload(); }, [user, reload]);
  if (user === undefined) return <main className="loading"><div className="brand-mark">CM</div><p>Opening your vault…</p></main>;
  if (!user) return <AuthScreen onAuthenticated={setUser} />;
  return <><header><div className="wordmark"><span className="brand-mark small">CM</span><div><strong>CipherMesh</strong><small>Control plane</small></div></div><div className="account"><span>{user.email}</span><button className="text-button" onClick={async () => { await logout(); setUser(null); }}>Sign out</button></div></header><main className="dashboard"><section className="hero"><p className="eyebrow">Zero-knowledge storage preview</p><h1>Your files. <em>Split by design.</em></h1><p>The master coordinates encrypted pieces. It never receives your plaintext or AES key.</p></section>{error && <p className="error banner">{error}</p>}<div className="dashboard-grid"><UploadPanel onComplete={reload} /><FileList files={files} selected={selected} onSelect={setSelected} /><MockNetwork />{selected && <FileDetails fileId={selected} onChanged={reload} />}</div></main></>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
