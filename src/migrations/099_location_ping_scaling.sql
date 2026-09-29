-- Raw GPS pings are high-volume operational history. The existing
-- (salesman_id, captured_at DESC) index serves last-fix and daily route reads.
-- This global captured_at index keeps bounded retention cleanup efficient.
CREATE INDEX IF NOT EXISTS idx_location_pings_captured_at
  ON location_pings (captured_at);
