-- Dedicated Google Places API request ledger. No place data is stored.
-- RLS prevents the Supabase Data API from accessing this backend-only table.
CREATE TABLE IF NOT EXISTS restaurant_finder_usage (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('search','contact')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS restaurant_finder_usage_kind_created_idx
  ON restaurant_finder_usage (kind, created_at DESC);
ALTER TABLE restaurant_finder_usage ENABLE ROW LEVEL SECURITY;
