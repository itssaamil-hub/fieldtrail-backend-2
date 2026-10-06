-- Remove the Reporting Manager hierarchy introduced in migration 114.
-- Keep migration 114 in history so deployed and fresh databases converge safely.

ALTER TABLE salesman_profiles
  DROP CONSTRAINT IF EXISTS salesman_profiles_no_self_reporting_manager;

DROP INDEX IF EXISTS idx_salesman_profiles_reporting_manager;

ALTER TABLE salesman_profiles
  DROP COLUMN IF EXISTS reporting_manager_id,
  DROP COLUMN IF EXISTS is_reporting_manager,
  DROP COLUMN IF EXISTS region;
