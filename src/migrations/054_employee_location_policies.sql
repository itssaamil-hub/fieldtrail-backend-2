-- Per-employee location policy. Existing employees inherit the current global
-- GPS/lead/tracking values once, then these settings are controlled only from
-- Employee Settings.
ALTER TABLE employee_day_closing_permissions
  ADD COLUMN IF NOT EXISTS gps_location BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS location_mandatory_for_new_lead BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS continuous_gps_tracking BOOLEAN NOT NULL DEFAULT true;

WITH current_location AS (
  SELECT COALESCE(location_settings, '{}'::jsonb) AS s
  FROM crm_settings
  ORDER BY updated_at DESC
  LIMIT 1
), defaults AS (
  SELECT
    COALESCE((s->>'gpsLocation')::boolean, true) AS gps_location,
    COALESCE((s->>'locationMandatoryForNewLead')::boolean, true) AS location_mandatory_for_new_lead,
    COALESCE((s->>'continuousGpsTracking')::boolean, true) AS continuous_gps_tracking
  FROM current_location
), effective AS (
  SELECT * FROM defaults
  UNION ALL
  SELECT true, true, true
  WHERE NOT EXISTS (SELECT 1 FROM defaults)
)
INSERT INTO employee_day_closing_permissions
  (user_id, gps_location, location_mandatory_for_new_lead, continuous_gps_tracking)
SELECT u.id, e.gps_location, e.location_mandatory_for_new_lead, e.continuous_gps_tracking
FROM users u
CROSS JOIN effective e
WHERE u.role='salesman'
ON CONFLICT (user_id) DO UPDATE SET
  gps_location=EXCLUDED.gps_location,
  location_mandatory_for_new_lead=EXCLUDED.location_mandatory_for_new_lead,
  continuous_gps_tracking=EXCLUDED.continuous_gps_tracking;
