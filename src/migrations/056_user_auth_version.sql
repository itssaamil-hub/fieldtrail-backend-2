ALTER TABLE users
  ADD COLUMN IF NOT EXISTS auth_version integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_users_auth_version
  ON users (id, auth_version);
