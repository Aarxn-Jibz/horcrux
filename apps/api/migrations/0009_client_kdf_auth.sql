ALTER TABLE users ADD COLUMN auth_kdf_version TEXT;
ALTER TABLE users ADD COLUMN auth_kdf_salt TEXT;
ALTER TABLE users ADD COLUMN auth_kdf_iterations INTEGER;
ALTER TABLE users ADD COLUMN auth_verifier TEXT;
CREATE UNIQUE INDEX users_auth_verifier_idx ON users(auth_verifier) WHERE auth_verifier IS NOT NULL;
