-- Core attendance/location policy hardening.
-- 1) Every salesman gets both policy rows.
-- 2) Future salesman accounts are provisioned automatically at the database layer.
-- 3) New/updated attendance rows cannot contain impossible timestamps or coordinates.

INSERT INTO employee_day_closing_permissions (user_id)
SELECT id FROM users WHERE role='salesman'
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO employee_location_settings (
  user_id,
  gps_location,
  location_mandatory_for_new_lead,
  continuous_gps_tracking
)
SELECT id, TRUE, TRUE, TRUE
FROM users
WHERE role='salesman'
ON CONFLICT (user_id) DO NOTHING;

CREATE OR REPLACE FUNCTION ensure_salesman_core_policies()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.role = 'salesman' THEN
    INSERT INTO employee_day_closing_permissions (user_id)
    VALUES (NEW.id)
    ON CONFLICT (user_id) DO NOTHING;

    INSERT INTO employee_location_settings (
      user_id,
      gps_location,
      location_mandatory_for_new_lead,
      continuous_gps_tracking
    )
    VALUES (NEW.id, TRUE, TRUE, TRUE)
    ON CONFLICT (user_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_users_ensure_salesman_core_policies ON users;
CREATE TRIGGER trg_users_ensure_salesman_core_policies
AFTER INSERT OR UPDATE OF role ON users
FOR EACH ROW
EXECUTE FUNCTION ensure_salesman_core_policies();

-- NOT VALID keeps deployment safe if historical bad rows exist while still
-- enforcing these checks for every new or changed attendance row.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='attendance_end_not_before_start'
  ) THEN
    ALTER TABLE attendance
      ADD CONSTRAINT attendance_end_not_before_start
      CHECK (end_day_at IS NULL OR start_day_at IS NULL OR end_day_at >= start_day_at)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='attendance_start_coordinates_valid'
  ) THEN
    ALTER TABLE attendance
      ADD CONSTRAINT attendance_start_coordinates_valid
      CHECK (
        (start_lat IS NULL OR start_lat BETWEEN -90 AND 90)
        AND (start_lng IS NULL OR start_lng BETWEEN -180 AND 180)
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='attendance_end_coordinates_valid'
  ) THEN
    ALTER TABLE attendance
      ADD CONSTRAINT attendance_end_coordinates_valid
      CHECK (
        (end_lat IS NULL OR end_lat BETWEEN -90 AND 90)
        AND (end_lng IS NULL OR end_lng BETWEEN -180 AND 180)
      ) NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_attendance_open_session_lookup
  ON attendance (salesman_id, start_day_at DESC)
  WHERE start_day_at IS NOT NULL AND end_day_at IS NULL;
