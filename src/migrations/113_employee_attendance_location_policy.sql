-- Make Start Day / End Day GPS requirements employee-specific.
-- Existing employees inherit the currently effective legacy company values once,
-- so this migration does not silently change today's attendance behavior.
ALTER TABLE employee_location_settings
  ADD COLUMN IF NOT EXISTS require_location_to_start_day BOOLEAN,
  ADD COLUMN IF NOT EXISTS require_location_to_end_day BOOLEAN;

WITH latest AS (
  SELECT location_settings
  FROM crm_settings
  ORDER BY updated_at DESC
  LIMIT 1
)
UPDATE employee_location_settings e
SET require_location_to_start_day = COALESCE(
      e.require_location_to_start_day,
      (SELECT (location_settings->>'requireLocationToStartDay')::boolean FROM latest),
      TRUE
    ),
    require_location_to_end_day = COALESCE(
      e.require_location_to_end_day,
      (SELECT (location_settings->>'requireLocationToEndDay')::boolean FROM latest),
      TRUE
    )
WHERE e.require_location_to_start_day IS NULL
   OR e.require_location_to_end_day IS NULL;

ALTER TABLE employee_location_settings
  ALTER COLUMN require_location_to_start_day SET DEFAULT TRUE,
  ALTER COLUMN require_location_to_start_day SET NOT NULL,
  ALTER COLUMN require_location_to_end_day SET DEFAULT TRUE,
  ALTER COLUMN require_location_to_end_day SET NOT NULL;
