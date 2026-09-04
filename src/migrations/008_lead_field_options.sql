-- Admin-managed preset options for lead form dropdowns (Category, POS
-- Name for now — generic field_key so more can be added later without a
-- schema change).
CREATE TABLE IF NOT EXISTS lead_field_options (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  field_key TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (field_key, value)
);

INSERT INTO lead_field_options (field_key, value)
SELECT 'category', v FROM unnest(ARRAY['Cafe', 'QSR', 'Casual Dining', 'Fine Dining', 'Cloud Kitchen', 'Bakery']) AS v
WHERE NOT EXISTS (SELECT 1 FROM lead_field_options WHERE field_key = 'category');

INSERT INTO lead_field_options (field_key, value)
SELECT 'pos_name', v FROM unnest(ARRAY['Petpooja', 'Restrowork', 'POSist', 'None / Manual']) AS v
WHERE NOT EXISTS (SELECT 1 FROM lead_field_options WHERE field_key = 'pos_name');
