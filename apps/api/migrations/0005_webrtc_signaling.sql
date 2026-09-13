CREATE TABLE webrtc_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX webrtc_sessions_node_idx ON webrtc_sessions(device_id, expires_at);

CREATE TABLE webrtc_signals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES webrtc_sessions(id) ON DELETE CASCADE,
  sender TEXT NOT NULL CHECK(sender IN ('browser','node')),
  signal_type TEXT NOT NULL CHECK(signal_type IN ('offer','answer','ice-candidate')),
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX webrtc_signals_session_idx ON webrtc_signals(session_id, created_at);
