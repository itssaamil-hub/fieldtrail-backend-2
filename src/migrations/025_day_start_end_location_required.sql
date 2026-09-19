-- Hidden enforcement flags for attendance GPS capture.
-- These are intentionally not exposed in the admin UI.
UPDATE crm_settings
SET location_settings = location_settings
  || '{"requireLocationToStartDay": true, "requireLocationToEndDay": true}'::jsonb,
    updated_at = now()
WHERE NOT (location_settings ? 'requireLocationToStartDay')
   OR NOT (location_settings ? 'requireLocationToEndDay');
