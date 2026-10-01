ALTER TABLE crm_settings
  ADD COLUMN IF NOT EXISTS display_settings JSONB NOT NULL DEFAULT '{"showAdminComparisons":true,"showEmployeeComparisons":true,"comparisonPeriod":"weekly"}'::jsonb;

UPDATE crm_settings
SET display_settings = '{"showAdminComparisons":true,"showEmployeeComparisons":true,"comparisonPeriod":"weekly"}'::jsonb
WHERE display_settings IS NULL;
