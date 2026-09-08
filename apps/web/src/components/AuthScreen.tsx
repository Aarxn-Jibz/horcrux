import { useState, type FormEvent } from "react";
import type { User } from "../lib/api";
import { login, register } from "../lib/api";

export function AuthScreen({ onAuthenticated }: { onAuthenticated(user: User): void }) {
  const [mode, setMode] = useState<"login" | "register">("login"); const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) { event.preventDefault(); setBusy(true); setError(""); try { onAuthenticated(await (mode === "login" ? login(email, password) : register(email, password))); } catch (cause) { setError(cause instanceof Error ? cause.message : "Authentication failed"); } finally { setBusy(false); } }
  return <main className="auth-shell"><section className="auth-card"><div className="brand-mark">CM</div><p className="eyebrow">Encrypted by you. Resilient by design.</p><h1>{mode === "login" ? "Welcome back" : "Create your vault"}</h1><p className="muted">Your files are encrypted and split before they leave this browser.</p><form onSubmit={submit}><label>Email<input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label><label>Password<input type="password" minLength={12} autoComplete={mode === "login" ? "current-password" : "new-password"} value={password} onChange={(e) => setPassword(e.target.value)} required /></label>{error && <p className="error" role="alert">{error}</p>}<button className="primary" disabled={busy}>{busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}</button></form><button className="text-button" onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(""); }}>{mode === "login" ? "New here? Create an account" : "Already registered? Sign in"}</button></section></main>;
}

