ALTER TABLE files ADD COLUMN format_version INTEGER NOT NULL DEFAULT 1 CHECK(format_version IN (1,2));
ALTER TABLE files ADD COLUMN chunk_size INTEGER;
ALTER TABLE files ADD COLUMN chunk_count INTEGER;
ALTER TABLE files ADD COLUMN nonce_prefix TEXT;
