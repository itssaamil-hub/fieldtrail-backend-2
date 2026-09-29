-- Admin lead list pagination/filtering indexes.
-- Existing status/salesman timeline indexes remain in place; these add the
-- newest-first global path and the common salesman+status combined path.
CREATE INDEX IF NOT EXISTS idx_leads_created_at_id_desc
  ON leads (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_leads_salesman_status_created_at_id_desc
  ON leads (salesman_id, status, created_at DESC, id DESC);
