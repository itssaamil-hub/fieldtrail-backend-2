-- Employee-scoped device access policy. Safe default preserves all current access.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS device_access_policy text NOT NULL DEFAULT 'both';
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS device_access_version integer NOT NULL DEFAULT 0;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'users_device_access_policy_check'
       AND conrelid = 'users'::regclass
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_device_access_policy_check
      CHECK (device_access_policy IN ('both', 'mobile_only'));
  END IF;
END $$;
