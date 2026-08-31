-- Fixes two real bugs found in production:
-- 1. Lead creation crashed on the status column (COALESCE + literal produced
--    a `text` result with no implicit cast to the lead_status enum) —
--    that's fixed in application code (salesman.routes.js), not here.
-- 2. Deleting a lead failed because notifications.lead_id had no ON DELETE
--    behavior — a lead with any notification (which is every lead, since
--    one is created on every "new_lead" event) could never be deleted.

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_lead_id_fkey;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_lead_id_fkey
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL;
