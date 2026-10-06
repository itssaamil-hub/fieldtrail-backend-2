-- Employee geographic profile fields for city-wise organization and future reporting.
-- Existing employees remain nullable until edited; new employees require both fields at the API layer.

ALTER TABLE salesman_profiles
  ADD COLUMN IF NOT EXISTS state_ut TEXT,
  ADD COLUMN IF NOT EXISTS city TEXT;

CREATE INDEX IF NOT EXISTS idx_salesman_profiles_state_city
  ON salesman_profiles (state_ut, city);
