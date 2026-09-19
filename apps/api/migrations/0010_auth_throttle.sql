CREATE TABLE auth_login_attempts (
  id TEXT PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0,
  blocked_until TEXT,
  expires_at TEXT NOT NULL
);
CREATE INDEX auth_login_attempts_expiry_idx ON auth_login_attempts(expires_at);
