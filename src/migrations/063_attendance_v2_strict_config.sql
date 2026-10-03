-- Attendance V2 hardening: never invent attendance policy or schedule values.
-- Employee overrides may inherit from the real company schedule, but missing
-- canonical policy/company configuration must fail instead of falling back.

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
  IF p.user_id IS NULL THEN
    RAISE EXCEPTION 'Attendance policy is missing for employee %', NEW.salesman_id;
  END IF;

  SELECT * INTO c FROM attendance_company_schedule WHERE id=1;
  IF c.id IS NULL THEN
    RAISE EXCEPTION 'Attendance company schedule is missing';
  END IF;

  SELECT * INTO e FROM attendance_employee_schedule WHERE user_id=NEW.salesman_id;

  IF NEW.closing_required_snapshot IS NULL THEN
    NEW.closing_required_snapshot := p.require_closing;
  END IF;
  IF NEW.expected_start_time_snapshot IS NULL THEN
    NEW.expected_start_time_snapshot := COALESCE(e.expected_start_time, c.expected_start_time);
  END IF;
  IF NEW.expected_end_time_snapshot IS NULL THEN
    NEW.expected_end_time_snapshot := COALESCE(e.expected_end_time, c.expected_end_time);
  END IF;
  IF NEW.late_tolerance_minutes_snapshot IS NULL THEN
    NEW.late_tolerance_minutes_snapshot := COALESCE(e.late_tolerance_minutes, c.late_tolerance_minutes);
  END IF;
  IF NEW.early_leave_tolerance_minutes_snapshot IS NULL THEN
    NEW.early_leave_tolerance_minutes_snapshot := COALESCE(e.early_leave_tolerance_minutes, c.early_leave_tolerance_minutes);
  END IF;
  IF NEW.long_session_minutes_snapshot IS NULL THEN
    NEW.long_session_minutes_snapshot := COALESCE(e.long_session_minutes, c.long_session_minutes);
  END IF;
  RETURN NEW;
END;
$$;
