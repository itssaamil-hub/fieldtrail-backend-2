-- Flexible attendance calendar: company defaults, per-employee schedules,
-- and date-specific exceptions. The default is Monday-Saturday working.
CREATE TABLE IF NOT EXISTS attendance_company_schedule (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  working_days SMALLINT[] NOT NULL DEFAULT ARRAY[1,2,3,4,5,6]::SMALLINT[],
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL
);

INSERT INTO attendance_company_schedule (id, working_days)
VALUES (1, ARRAY[1,2,3,4,5,6]::SMALLINT[])
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS attendance_employee_schedule (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  working_days SMALLINT[] NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS attendance_calendar_exceptions (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('holiday','leave','weekly_off','working_day')),
  label VARCHAR(120),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_attendance_global_exception_day
  ON attendance_calendar_exceptions(day)
  WHERE user_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_attendance_employee_exception_day
  ON attendance_calendar_exceptions(user_id, day)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_attendance_calendar_exception_range
  ON attendance_calendar_exceptions(day, user_id);
