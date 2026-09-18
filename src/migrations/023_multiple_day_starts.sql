-- Support multiple Start Day / End Day cycles in one calendar day, gated by
-- a new Location Setting ("allowMultipleDayStarts", default off — preserves
-- the existing once-a-day behavior for installs that don't turn it on).
--
-- The old UNIQUE (salesman_id, day) constraint is what enforced "once a
-- day" at the database level; replacing it with (salesman_id, day,
-- session_number) lets a salesman start a second (third, etc.) session on
-- the same day once their previous session has ended, while still
-- preventing two simultaneously-active sessions (enforced in application
-- code via activeAttendance()).
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS session_number INT NOT NULL DEFAULT 1;
ALTER TABLE attendance DROP CONSTRAINT IF EXISTS attendance_salesman_id_day_key;
ALTER TABLE attendance ADD CONSTRAINT attendance_salesman_day_session_unique UNIQUE (salesman_id, day, session_number);

UPDATE crm_settings
SET location_settings = location_settings || '{"allowMultipleDayStarts": false}'::jsonb
WHERE NOT (location_settings ? 'allowMultipleDayStarts');
