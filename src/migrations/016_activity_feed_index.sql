-- Bounded, newest-first activity pages, with stable ordering for equal timestamps.
CREATE INDEX IF NOT EXISTS idx_activity_logs_created_id ON activity_logs (created_at DESC, id DESC);
