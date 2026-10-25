-- Private, server-managed sharing grants. No CRM rows are copied here.
CREATE TABLE IF NOT EXISTS broadcast_links (
 id uuid PRIMARY KEY,
 created_by uuid NOT NULL REFERENCES users(id),
 config jsonb NOT NULL,
 pin_hash text,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz,
 revoked_at timestamptz,
 revoked_by uuid REFERENCES users(id),
 failed_attempts integer NOT NULL DEFAULT 0,
 locked_until timestamptz
);
CREATE INDEX IF NOT EXISTS broadcast_links_created_idx ON broadcast_links(created_at DESC);
ALTER TABLE broadcast_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON broadcast_links FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON broadcast_links FROM anon; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON broadcast_links FROM authenticated; END IF;
END $$;
