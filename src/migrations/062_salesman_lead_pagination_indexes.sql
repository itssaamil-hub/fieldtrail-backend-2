-- Supports salesman-owned newest-first pages and status-filtered pages.
CREATE INDEX IF NOT EXISTS idx_leads_salesman_status_created_id
  ON leads (salesman_id, status, created_at DESC, id DESC);
