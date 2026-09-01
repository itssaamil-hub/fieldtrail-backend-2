-- 1. "area" was already used by the frontend/API mapping but never
--    actually existed as a column — it silently fell back to "Unassigned"
--    every time. Add it for real so create/edit actually persists it.
ALTER TABLE salesman_profiles ADD COLUMN IF NOT EXISTS area TEXT;

-- 2. Deleting a salesman currently fails: several tables reference
--    users(id) with no ON DELETE behavior, so Postgres blocks the delete
--    with a foreign-key violation. Per the intended rule — leads must be
--    deleted first, everything else is just historical activity — leave
--    leads.salesman_id exactly as-is (that's what enforces "delete leads
--    first") and let the salesman's own operational history clean up
--    alongside them, while genuinely historical audit trails (who did
--    what) survive with a null actor instead of disappearing.

ALTER TABLE location_pings DROP CONSTRAINT IF EXISTS location_pings_salesman_id_fkey;
ALTER TABLE location_pings
  ADD CONSTRAINT location_pings_salesman_id_fkey
  FOREIGN KEY (salesman_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE visits DROP CONSTRAINT IF EXISTS visits_salesman_id_fkey;
ALTER TABLE visits
  ADD CONSTRAINT visits_salesman_id_fkey
  FOREIGN KEY (salesman_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE attendance DROP CONSTRAINT IF EXISTS attendance_salesman_id_fkey;
ALTER TABLE attendance
  ADD CONSTRAINT attendance_salesman_id_fkey
  FOREIGN KEY (salesman_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE lead_assignments DROP CONSTRAINT IF EXISTS lead_assignments_salesman_id_fkey;
ALTER TABLE lead_assignments
  ADD CONSTRAINT lead_assignments_salesman_id_fkey
  FOREIGN KEY (salesman_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_salesman_id_fkey;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_salesman_id_fkey
  FOREIGN KEY (salesman_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE activity_logs DROP CONSTRAINT IF EXISTS activity_logs_actor_id_fkey;
ALTER TABLE activity_logs
  ADD CONSTRAINT activity_logs_actor_id_fkey
  FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE lead_status_history DROP CONSTRAINT IF EXISTS lead_status_history_changed_by_fkey;
ALTER TABLE lead_status_history
  ADD CONSTRAINT lead_status_history_changed_by_fkey
  FOREIGN KEY (changed_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE lead_assignments DROP CONSTRAINT IF EXISTS lead_assignments_assigned_by_fkey;
ALTER TABLE lead_assignments
  ADD CONSTRAINT lead_assignments_assigned_by_fkey
  FOREIGN KEY (assigned_by) REFERENCES users(id) ON DELETE SET NULL;

-- Same landmine as notifications.lead_id fixed earlier: a visit optionally
-- links to a lead, and deleting that lead would otherwise be blocked.
ALTER TABLE visits DROP CONSTRAINT IF EXISTS visits_lead_id_fkey;
ALTER TABLE visits
  ADD CONSTRAINT visits_lead_id_fkey
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL;
