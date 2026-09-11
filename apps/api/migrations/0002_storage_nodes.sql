ALTER TABLE devices ADD COLUMN public_key TEXT;
ALTER TABLE devices ADD COLUMN available_storage INTEGER NOT NULL DEFAULT 0 CHECK(available_storage >= 0);
ALTER TABLE devices ADD COLUMN node_version TEXT;
ALTER TABLE devices ADD COLUMN protocol_version TEXT;
ALTER TABLE devices ADD COLUMN health TEXT NOT NULL DEFAULT 'unknown' CHECK(health IN ('healthy','degraded','unknown'));
CREATE UNIQUE INDEX devices_public_key_idx ON devices(public_key) WHERE public_key IS NOT NULL;

CREATE TABLE device_enrollment_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX enrollment_challenges_user_idx ON device_enrollment_challenges(user_id, expires_at);

CREATE TABLE issued_capabilities (
  jti TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  object_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('PUT','GET','DELETE')),
  checksum TEXT,
  size INTEGER,
  expires_at TEXT NOT NULL,
  receipt_received_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX issued_capabilities_object_idx ON issued_capabilities(device_id, object_id, operation);

CREATE TABLE storage_receipts (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  object_id TEXT NOT NULL,
  checksum TEXT NOT NULL,
  size INTEGER NOT NULL CHECK(size >= 0),
  stored_at TEXT NOT NULL,
  signature TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(device_id, object_id)
);
CREATE INDEX storage_receipts_file_idx ON storage_receipts(file_id, device_id);

UPDATE devices SET available_storage = storage_capacity - storage_used, protocol_version = 'mock', health = 'healthy' WHERE public_identifier LIKE 'mock://%';
