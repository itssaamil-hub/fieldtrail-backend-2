-- CRM Lead Settings, Location Settings, and additional lead fields
-- (sub location, POS name, renewal month/date) needed for the export.

ALTER TABLE leads ADD COLUMN IF NOT EXISTS sub_location TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS pos_name TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS renewal_month TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS renewal_date DATE;

-- Location fields become optional at the DB level — whether they're
-- actually required is now a runtime decision driven by crm_settings
-- (enforced in the API layer), not a hard DB constraint. This lets an
-- admin turn "GPS Location" off entirely without breaking inserts.
ALTER TABLE leads ALTER COLUMN latitude DROP NOT NULL;
ALTER TABLE leads ALTER COLUMN longitude DROP NOT NULL;
ALTER TABLE leads ALTER COLUMN accuracy_m DROP NOT NULL;
ALTER TABLE leads ALTER COLUMN device_id DROP NOT NULL;

-- The write-once trigger currently rejects any UPDATE where these fields
-- are NULL-compared; NULL vs NULL with IS DISTINCT FROM correctly reports
-- "not distinct" so this still holds even with nullable columns — no
-- change needed there.

CREATE TABLE IF NOT EXISTS crm_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_settings JSONB NOT NULL,
  location_settings JSONB NOT NULL,
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO crm_settings (lead_settings, location_settings)
SELECT
  '{
    "requireBusinessName": true,
    "requireSubLocation": true,
    "requirePosName": true,
    "requireContactName": true,
    "requireContactNumber": true,
    "requireStatus": true,
    "requireComments": false
  }'::jsonb,
  '{
    "gpsLocation": true,
    "locationMandatoryForNewLead": true,
    "continuousGpsTracking": true
  }'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM crm_settings);
