-- Sub Location joins Category/POS Name as an admin-manageable preset field.
INSERT INTO lead_field_options (field_key, value)
SELECT 'sub_location', v FROM unnest(ARRAY['Gomti Nagar', 'Hazratganj', 'Indira Nagar', 'Alambagh']) AS v
WHERE NOT EXISTS (SELECT 1 FROM lead_field_options WHERE field_key = 'sub_location');

-- Expected Deal Value — captured at lead creation, editable after, and
-- summed for "Converted" (won leads) on the admin dashboard.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS deal_value NUMERIC(12,2);

-- Add the new Lead Setting toggle (default off) to the existing settings
-- row without clobbering whatever's already there.
UPDATE crm_settings
SET lead_settings = lead_settings || '{"requireDealValue": false}'::jsonb
WHERE NOT (lead_settings ? 'requireDealValue');
