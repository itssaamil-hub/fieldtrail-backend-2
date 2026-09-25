-- Per-employee location/tracking policy.
-- Existing employees inherit the currently effective global values once,
-- then these controls are managed only from Employee Settings.
CREATE TABLE IF NOT EXISTS employee_location_settings (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  gps_location BOOLEAN NOT NULL DEFAULT TRUE,
  location_mandatory_for_new_lead BOOLEAN NOT NULL DEFAULT TRUE,
  continuous_gps_tracking BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

WITH latest AS (
  SELECT location_settings
  FROM crm_settings
  ORDER BY updated_at DESC
  LIMIT 1
)
INSERT INTO employee_location_settings (
  user_id,
  gps_location,
  location_mandatory_for_new_lead,
  continuous_gps_tracking
)
SELECT
  u.id,
  COALESCE((latest.location_settings->>'gpsLocation')::boolean, TRUE),
  COALESCE((latest.location_settings->>'locationMandatoryForNewLead')::boolean, TRUE),
  COALESCE((latest.location_settings->>'continuousGpsTracking')::boolean, TRUE)
FROM users u
LEFT JOIN latest ON TRUE
WHERE u.role='salesman'
ON CONFLICT (user_id) DO NOTHING;

-- Keep the old JSON keys only as internal compatibility defaults for legacy
-- handlers. They are no longer admin-configurable and are deliberately
-- permissive so the employee policy becomes authoritative.
UPDATE crm_settings
SET location_settings = jsonb_set(
  jsonb_set(
    jsonb_set(location_settings, '{gpsLocation}', 'true'::jsonb, true),
    '{locationMandatoryForNewLead}', 'false'::jsonb, true
  ),
  '{continuousGpsTracking}', 'true'::jsonb, true
),
updated_at = now();
