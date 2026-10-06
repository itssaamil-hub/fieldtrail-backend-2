-- Reporting Manager hierarchy for Engage.
-- Authentication roles remain admin/salesman so existing salesman workflows stay intact.
-- Reporting-manager designation is an employee/profile responsibility, not a new auth role.

ALTER TABLE salesman_profiles
  ADD COLUMN IF NOT EXISTS region TEXT,
  ADD COLUMN IF NOT EXISTS is_reporting_manager BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reporting_manager_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_salesman_profiles_reporting_manager
  ON salesman_profiles (reporting_manager_id)
  WHERE reporting_manager_id IS NOT NULL;

ALTER TABLE salesman_profiles
  DROP CONSTRAINT IF EXISTS salesman_profiles_no_self_reporting_manager;

ALTER TABLE salesman_profiles
  ADD CONSTRAINT salesman_profiles_no_self_reporting_manager
  CHECK (reporting_manager_id IS NULL OR reporting_manager_id <> user_id);
