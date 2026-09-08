PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE refresh_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  replaced_by_token_id TEXT REFERENCES refresh_tokens(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens(user_id);
CREATE INDEX refresh_tokens_active_idx ON refresh_tokens(token_hash, revoked_at);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  public_identifier TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('online','offline','degraded','disabled')),
  storage_capacity INTEGER NOT NULL CHECK(storage_capacity >= 0),
  storage_used INTEGER NOT NULL DEFAULT 0 CHECK(storage_used >= 0),
  last_seen TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX devices_owner_idx ON devices(owner_user_id);
CREATE INDEX devices_status_idx ON devices(status);

CREATE TABLE files (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  original_size INTEGER NOT NULL CHECK(original_size >= 0),
  compressed_size INTEGER CHECK(compressed_size >= 0),
  encrypted_size INTEGER CHECK(encrypted_size >= 0),
  plaintext_hash TEXT NOT NULL,
  ciphertext_hash TEXT,
  status TEXT NOT NULL CHECK(status IN ('uploading','available','failed','deleted')),
  encryption_algorithm TEXT NOT NULL DEFAULT 'AES-256-GCM',
  compression_algorithm TEXT NOT NULL DEFAULT 'zstd',
  encryption_iv TEXT,
  rs_data_shards INTEGER NOT NULL CHECK(rs_data_shards > 0),
  rs_parity_shards INTEGER NOT NULL CHECK(rs_parity_shards > 0),
  rs_shard_size INTEGER,
  key_share_threshold INTEGER NOT NULL CHECK(key_share_threshold > 1),
  key_share_count INTEGER NOT NULL CHECK(key_share_count >= key_share_threshold),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  deleted_at TEXT
);
CREATE INDEX files_owner_status_idx ON files(owner_user_id, status, created_at DESC);

CREATE TABLE upload_sessions (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('initialized','distributing','committing','complete','aborted')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX upload_sessions_file_idx ON upload_sessions(file_id);
CREATE INDEX upload_sessions_user_idx ON upload_sessions(user_id, status);

CREATE TABLE shards (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  shard_index INTEGER NOT NULL,
  shard_type TEXT NOT NULL CHECK(shard_type IN ('data','parity')),
  size INTEGER NOT NULL CHECK(size >= 0),
  checksum TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','stored','missing','corrupt','deleted')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(file_id, shard_index)
);
CREATE INDEX shards_file_status_idx ON shards(file_id, status);

CREATE TABLE shard_locations (
  id TEXT PRIMARY KEY,
  shard_id TEXT NOT NULL REFERENCES shards(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
  object_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','stored','missing','deleted')),
  stored_at TEXT,
  UNIQUE(shard_id, device_id),
  UNIQUE(device_id, object_id)
);
CREATE INDEX shard_locations_device_idx ON shard_locations(device_id, status);

CREATE TABLE key_shares (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  share_index INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  size INTEGER NOT NULL CHECK(size > 0),
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
  object_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','stored','missing','deleted')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(file_id, share_index),
  UNIQUE(device_id, object_id)
);
CREATE INDEX key_shares_file_status_idx ON key_shares(file_id, status);

INSERT INTO devices (id, public_identifier, name, status, storage_capacity)
VALUES
 ('mock-a', 'mock://node-a', 'Mock node A', 'online', 1073741824),
 ('mock-b', 'mock://node-b', 'Mock node B', 'online', 1073741824),
 ('mock-c', 'mock://node-c', 'Mock node C', 'online', 1073741824),
 ('mock-d', 'mock://node-d', 'Mock node D', 'online', 1073741824),
 ('mock-e', 'mock://node-e', 'Mock node E', 'online', 1073741824);
