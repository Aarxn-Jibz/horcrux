ALTER TABLE files ADD COLUMN deletion_state TEXT CHECK(deletion_state = 'pending');
ALTER TABLE files ADD COLUMN deletion_requested_at TEXT;

CREATE TABLE file_deletion_tasks (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
  object_id TEXT NOT NULL,
  object_kind TEXT NOT NULL CHECK(object_kind IN ('shard','key-share')),
  source_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','deleted')) DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  last_dispatched_at TEXT,
  last_error TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(file_id, object_kind, source_id),
  UNIQUE(file_id, device_id, object_id)
);
CREATE INDEX file_deletion_tasks_node_pending_idx ON file_deletion_tasks(device_id, status, created_at);
CREATE INDEX file_deletion_tasks_file_pending_idx ON file_deletion_tasks(file_id, status);
