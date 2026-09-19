ALTER TABLE employee_day_closing_permissions
  ADD COLUMN IF NOT EXISTS allow_lead_without_start_day BOOLEAN NOT NULL DEFAULT false;
