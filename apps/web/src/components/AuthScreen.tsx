import { useId, useState, type FormEvent } from "react";
import type { User } from "../lib/api";
import { login, register } from "../lib/api";
import { BrandMark } from "./BrandMark";

type AuthMode = "login" | "register";

export function AuthScreen({ onAuthenticated }: { onAuthenticated(user: User): void }) {
  const emailId = useId();
  const passwordId = useId();
  const confirmationId = useId();
  const [mode, setMode] = useState<AuthMode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (mode === "register" && password !== confirmation) {
      setError("Passwords do not match.");
      return;
    }

    setBusy(true);
    try {
      const user = await (mode === "login" ? login(email, password) : register(email, password));
      onAuthenticated(user);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Authentication failed");
    } finally {
      setBusy(false);
    }
  }

  function switchMode() {
    setMode((current) => current === "login" ? "register" : "login");
    setConfirmation("");
    setError("");
  }

  const isLogin = mode === "login";
  return (
    <main className="auth-shell">
      <section className="auth-card" aria-labelledby="auth-title">
        <div className="auth-brand" aria-label="Horcrux File System">
          <BrandMark />
          <span>Horcrux</span>
        </div>
        <div className="horcrux-motif" aria-hidden="true">
          {Array.from({ length: 5 }, (_, index) => <span key={index} />)}
        </div>
        <div className="auth-heading">
          <h1 id="auth-title">{isLogin ? "Sign in" : "Create an account"}</h1>
          <p>{isLogin ? "Continue to your encrypted file system." : "Set up your encrypted file system."}</p>
        </div>
        <form onSubmit={submit} aria-busy={busy}>
          <label htmlFor={emailId}>Email</label>
          <input id={emailId} type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" disabled={busy} required />
          <label htmlFor={passwordId}>Password</label>
          <input id={passwordId} type="password" minLength={8} autoComplete={isLogin ? "current-password" : "new-password"} value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} required />
          {!isLogin && (
            <>
              <label htmlFor={confirmationId}>Confirm password</label>
              <input id={confirmationId} type="password" minLength={8} autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} disabled={busy} required />
            </>
          )}
          {error && <p className="error auth-error" role="alert">{error}</p>}
          <button className="primary auth-submit" disabled={busy} type="submit">{busy ? "Please wait…" : isLogin ? "Sign in" : "Create account"}</button>
        </form>
        <p className="auth-switch">
          {isLogin ? "New to Horcrux?" : "Already have an account?"}
          <button className="text-button" type="button" onClick={switchMode} disabled={busy}>{isLogin ? "Create an account" : "Sign in"}</button>
        </p>
      </section>
    </main>
  );
}
