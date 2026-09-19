-- 1) Per-employee "Allow multiple Start Day / End Day cycles per day".
--    The admin UI (Employee Settings) already shows this switch, but until now
--    the server only honoured the global Location Setting, so the per-employee
--    switch was silently ignored.
ALTER TABLE employee_day_closing_permissions
  ADD COLUMN IF NOT EXISTS allow_multiple_starts BOOLEAN NOT NULL DEFAULT false;

-- 2) Push preference for "employee started / ended their day" alerts sent to
--    admins. Defaults ON so existing admins start receiving them.
ALTER TABLE notification_preferences
  ADD COLUMN IF NOT EXISTS day_activity BOOLEAN NOT NULL DEFAULT true;
