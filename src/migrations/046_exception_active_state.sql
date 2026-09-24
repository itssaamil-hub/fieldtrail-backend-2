ALTER TABLE exception_cases
  ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS exception_cases_active_status_idx
  ON exception_cases(active, status, severity, updated_at DESC);
