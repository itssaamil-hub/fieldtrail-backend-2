-- Attendance V2: schedule times, historical policy snapshots, audit trail and controlled corrections.

ALTER TABLE attendance_company_schedule
  ADD COLUMN IF NOT EXISTS expected_start_time TIME,
  ADD COLUMN IF NOT EXISTS expected_end_time TIME,
  ADD COLUMN IF NOT EXISTS late_tolerance_minutes INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS early_leave_tolerance_minutes INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS long_session_minutes INTEGER NOT NULL DEFAULT 720;

ALTER TABLE attendance_employee_schedule
  ADD COLUMN IF NOT EXISTS expected_start_time TIME,
  ADD COLUMN IF NOT EXISTS expected_end_time TIME,
  ADD COLUMN IF NOT EXISTS late_tolerance_minutes INTEGER,
  ADD COLUMN IF NOT EXISTS early_leave_tolerance_minutes INTEGER,
  ADD COLUMN IF NOT EXISTS long_session_minutes INTEGER;

ALTER TABLE attendance
  ADD COLUMN IF NOT EXISTS closing_required_snapshot BOOLEAN,
  ADD COLUMN IF NOT EXISTS expected_start_time_snapshot TIME,
  ADD COLUMN IF NOT EXISTS expected_end_time_snapshot TIME,
  ADD COLUMN IF NOT EXISTS late_tolerance_minutes_snapshot INTEGER,
  ADD COLUMN IF NOT EXISTS early_leave_tolerance_minutes_snapshot INTEGER,
  ADD COLUMN IF NOT EXISTS long_session_minutes_snapshot INTEGER;

-- Historical rows with an existing Day Closing permission snapshot can be
-- backfilled safely. Rows with no historical evidence stay NULL rather than
-- being guessed from today's policy.
UPDATE attendance a
SET closing_required_snapshot = (r.permissions->>'require_closing')::boolean
FROM day_closing_reports r
WHERE r.attendance_id = a.id
  AND a.closing_required_snapshot IS NULL
  AND r.permissions ? 'require_closing'
  AND r.permissions->>'require_closing' IN ('true','false');

-- Snapshot the policy and effective schedule at the moment Start Day creates a
-- session. This makes later reports independent from future settings changes.
CREATE OR REPLACE FUNCTION snapshot_attendance_policy_and_schedule()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  p employee_day_closing_permissions%ROWTYPE;
  c attendance_company_schedule%ROWTYPE;
  e attendance_employee_schedule%ROWTYPE;
BEGIN
  SELECT * INTO p FROM employee_day_closing_permissions WHERE user_id=NEW.salesman_id;
  SELECT * INTO c FROM attendance_company_schedule WHERE id=1;
  SELECT * INTO e FROM attendance_employee_schedule WHERE user_id=NEW.salesman_id;

  IF NEW.closing_required_snapshot IS NULL THEN
    NEW.closing_required_snapshot := COALESCE(p.require_closing, false);
  END IF;
  IF NEW.expected_start_time_snapshot IS NULL THEN
    NEW.expected_start_time_snapshot := COALESCE(e.expected_start_time, c.expected_start_time);
  END IF;
  IF NEW.expected_end_time_snapshot IS NULL THEN
    NEW.expected_end_time_snapshot := COALESCE(e.expected_end_time, c.expected_end_time);
  END IF;
  IF NEW.late_tolerance_minutes_snapshot IS NULL THEN
    NEW.late_tolerance_minutes_snapshot := COALESCE(e.late_tolerance_minutes, c.late_tolerance_minutes, 0);
  END IF;
  IF NEW.early_leave_tolerance_minutes_snapshot IS NULL THEN
    NEW.early_leave_tolerance_minutes_snapshot := COALESCE(e.early_leave_tolerance_minutes, c.early_leave_tolerance_minutes, 0);
  END IF;
  IF NEW.long_session_minutes_snapshot IS NULL THEN
    NEW.long_session_minutes_snapshot := COALESCE(e.long_session_minutes, c.long_session_minutes, 720);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_attendance_snapshot_policy_schedule ON attendance;
CREATE TRIGGER trg_attendance_snapshot_policy_schedule
BEFORE INSERT ON attendance
FOR EACH ROW
EXECUTE FUNCTION snapshot_attendance_policy_and_schedule();

CREATE TABLE IF NOT EXISTS attendance_exception_audit (
  id BIGSERIAL PRIMARY KEY,
  exception_id BIGINT,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  day DATE NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('created','replaced','deleted')),
  before_value JSONB,
  after_value JSONB,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_attendance_exception_audit_day
  ON attendance_exception_audit(day, user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS attendance_corrections (
  id BIGSERIAL PRIMARY KEY,
  attendance_id UUID NOT NULL REFERENCES attendance(id) ON DELETE CASCADE,
  correction_type TEXT NOT NULL CHECK (correction_type IN ('close_stale_session')),
  previous_value JSONB NOT NULL DEFAULT '{}'::jsonb,
  corrected_value JSONB NOT NULL DEFAULT '{}'::jsonb,
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_attendance_corrections_attendance
  ON attendance_corrections(attendance_id, created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='attendance_company_schedule_tolerance_check') THEN
    ALTER TABLE attendance_company_schedule ADD CONSTRAINT attendance_company_schedule_tolerance_check
      CHECK (late_tolerance_minutes BETWEEN 0 AND 240
        AND early_leave_tolerance_minutes BETWEEN 0 AND 240
        AND long_session_minutes BETWEEN 60 AND 2880) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='attendance_employee_schedule_tolerance_check') THEN
    ALTER TABLE attendance_employee_schedule ADD CONSTRAINT attendance_employee_schedule_tolerance_check
      CHECK ((late_tolerance_minutes IS NULL OR late_tolerance_minutes BETWEEN 0 AND 240)
        AND (early_leave_tolerance_minutes IS NULL OR early_leave_tolerance_minutes BETWEEN 0 AND 240)
        AND (long_session_minutes IS NULL OR long_session_minutes BETWEEN 60 AND 2880)) NOT VALID;
  END IF;
END $$;
