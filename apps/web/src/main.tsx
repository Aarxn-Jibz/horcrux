import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { FileSummary } from "@horcrux-file-system/shared";
import "./styles.css";
import { AuthScreen } from "./components/AuthScreen";
import { FileDetails } from "./components/FileDetails";
import { FileList } from "./components/FileList";
import { MockNetwork } from "./components/MockNetwork";
import { UploadPanel } from "./components/UploadPanel";
import { listFiles, logout, refresh, type User } from "./lib/api";

type View = "files" | "devices";

function App() {
  const [user, setUser] = useState<User | null>();
  const [files, setFiles] = useState<FileSummary[]>([]);
  const [selected, setSelected] = useState<string>();
  const [view, setView] = useState<View>("files");
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    try {
      const next = await listFiles();
      setFiles(next);
      setSelected((current) => current && next.some((file) => file.fileId === current) ? current : undefined);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load files");
    }
  }, []);

  useEffect(() => {
    refresh().then(setUser).catch(() => setUser(null));
  }, []);

  useEffect(() => {
    if (user) void reload();
  }, [user, reload]);

  if (user === undefined) {
    return <main className="loading"><div className="brand-mark">HFS</div><p>Opening Horcrux…</p></main>;
  }
  if (!user) return <AuthScreen onAuthenticated={setUser} />;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="wordmark">
          <span className="brand-mark small">HFS</span>
          <strong>Horcrux</strong>
        </div>
        <nav className="primary-nav" aria-label="Primary navigation">
          <button className={view === "files" ? "active" : ""} onClick={() => setView("files")}>Files</button>
          <button className={view === "devices" ? "active" : ""} onClick={() => setView("devices")}>Devices</button>
        </nav>
        <div className="account">
          <span className="account-email">{user.email}</span>
          <button className="text-button" onClick={async () => { await logout(); setUser(null); }}>Sign out</button>
        </div>
      </header>
      <main className="workspace">
        {error && <p className="error banner" role="alert">{error}</p>}
        {view === "files" ? (
          <>
            <div className="page-heading">
              <div><h1>Files</h1><p>Encrypted and distributed from this browser.</p></div>
              <UploadPanel onComplete={reload} />
            </div>
            <FileList files={files} selected={selected} onSelect={setSelected} />
            {selected && <FileDetails fileId={selected} onClose={() => setSelected(undefined)} onChanged={reload} />}
          </>
        ) : (
          <>
            <div className="page-heading">
              <div><h1>Devices</h1><p>Storage capacity and availability across your network.</p></div>
            </div>
            <MockNetwork />
          </>
        )}
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
