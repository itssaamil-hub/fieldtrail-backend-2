-- Activity Centre reads are newest-first and limited to short date windows.
-- These indexes keep the dashboard cheap as audit history grows.
CREATE INDEX IF NOT EXISTS idx_activity_logs_actor_created ON activity_logs (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_logs_action_created ON activity_logs (action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_salesman_created ON leads (salesman_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_payments_paid_at ON lead_payments (paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_quotation_events_created_at ON quotation_events (created_at DESC);
