ALTER TABLE devices ADD COLUMN endpoint TEXT;
CREATE INDEX devices_endpoint_idx ON devices(endpoint) WHERE endpoint IS NOT NULL;
