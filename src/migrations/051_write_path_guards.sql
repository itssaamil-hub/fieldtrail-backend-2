-- Core write-path guards.
-- These protections preserve the current application flow while preventing
-- invalid/concurrent rows from entering the database going forward.

-- Existing historical rows are intentionally not validated here. NOT VALID
-- means current production data will not block deployment, while all new or
-- updated rows must satisfy the checks.

DO $$ BEGIN
  ALTER TABLE location_pings ADD CONSTRAINT chk_location_pings_lat
    CHECK (latitude BETWEEN -90 AND 90) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE location_pings ADD CONSTRAINT chk_location_pings_lng
    CHECK (longitude BETWEEN -180 AND 180) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE location_pings ADD CONSTRAINT chk_location_pings_accuracy
    CHECK (accuracy_m IS NULL OR accuracy_m >= 0) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE location_pings ADD CONSTRAINT chk_location_pings_battery
    CHECK (battery_pct IS NULL OR battery_pct BETWEEN 0 AND 100) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE visits ADD CONSTRAINT chk_visits_lat
    CHECK (latitude BETWEEN -90 AND 90) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE visits ADD CONSTRAINT chk_visits_lng
    CHECK (longitude BETWEEN -180 AND 180) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE visits ADD CONSTRAINT chk_visits_accuracy
    CHECK (accuracy_m IS NULL OR accuracy_m >= 0) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE visits ADD CONSTRAINT chk_visits_time_order
    CHECK (left_at IS NULL OR left_at >= arrived_at) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE attendance ADD CONSTRAINT chk_attendance_start_lat
    CHECK (start_lat IS NULL OR start_lat BETWEEN -90 AND 90) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE attendance ADD CONSTRAINT chk_attendance_start_lng
    CHECK (start_lng IS NULL OR start_lng BETWEEN -180 AND 180) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE attendance ADD CONSTRAINT chk_attendance_end_lat
    CHECK (end_lat IS NULL OR end_lat BETWEEN -90 AND 90) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE attendance ADD CONSTRAINT chk_attendance_end_lng
    CHECK (end_lng IS NULL OR end_lng BETWEEN -180 AND 180) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE attendance ADD CONSTRAINT chk_attendance_time_order
    CHECK (end_day_at IS NULL OR start_day_at IS NULL OR end_day_at >= start_day_at) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One employee may have only one currently-open Start Day session. A trigger
-- is used instead of an immediate unique-index migration so legacy duplicate
-- sessions, if any, do not make deployment fail. The employee row is already
-- locked by the Start/End Day service, but this is the DB-level final guard.
CREATE OR REPLACE FUNCTION engage_guard_single_open_attendance()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.start_day_at IS NOT NULL AND NEW.end_day_at IS NULL THEN
    IF EXISTS (
      SELECT 1 FROM attendance a
      WHERE a.salesman_id = NEW.salesman_id
        AND a.start_day_at IS NOT NULL
        AND a.end_day_at IS NULL
        AND a.id IS DISTINCT FROM NEW.id
    ) THEN
      RAISE EXCEPTION 'employee already has an active Start Day session'
        USING ERRCODE = '23505';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_engage_single_open_attendance ON attendance;
CREATE TRIGGER trg_engage_single_open_attendance
BEFORE INSERT OR UPDATE OF salesman_id,start_day_at,end_day_at ON attendance
FOR EACH ROW EXECUTE FUNCTION engage_guard_single_open_attendance();

-- Leads must always be owned by a salesman account. This prevents accidental
-- admin/user IDs from being written through a future route or manual query.
CREATE OR REPLACE FUNCTION engage_guard_lead_owner_role()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM users u
    WHERE u.id=NEW.salesman_id AND u.role='salesman'
  ) THEN
    RAISE EXCEPTION 'lead owner must be a salesman account'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_engage_lead_owner_role ON leads;
CREATE TRIGGER trg_engage_lead_owner_role
BEFORE INSERT OR UPDATE OF salesman_id ON leads
FOR EACH ROW EXECUTE FUNCTION engage_guard_lead_owner_role();

-- Open tasks linked to a lead should stay with that lead's current owner.
-- This matches the current application rule and prevents inconsistent writes
-- from future endpoints. Completed historical tasks remain untouched.
CREATE OR REPLACE FUNCTION engage_guard_task_assignment()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE lead_owner uuid;
BEGIN
  IF NEW.lead_id IS NOT NULL AND NEW.status <> 'completed' THEN
    SELECT salesman_id INTO lead_owner FROM leads WHERE id=NEW.lead_id;
    IF lead_owner IS NULL THEN
      RAISE EXCEPTION 'linked lead does not exist' USING ERRCODE='23503';
    END IF;
    IF NEW.assigned_to IS DISTINCT FROM lead_owner THEN
      RAISE EXCEPTION 'linked task must be assigned to the lead owner'
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_engage_task_assignment ON crm_tasks;
CREATE TRIGGER trg_engage_task_assignment
BEFORE INSERT OR UPDATE OF lead_id,assigned_to,status ON crm_tasks
FOR EACH ROW EXECUTE FUNCTION engage_guard_task_assignment();

-- Supporting indexes for the guard checks and common ownership lookups.
CREATE INDEX IF NOT EXISTS idx_attendance_open_by_salesman
  ON attendance(salesman_id) WHERE start_day_at IS NOT NULL AND end_day_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_tasks_open_lead_owner
  ON crm_tasks(lead_id,assigned_to) WHERE lead_id IS NOT NULL AND status <> 'completed';
