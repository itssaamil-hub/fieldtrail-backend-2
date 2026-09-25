-- Backend hardening indexes for common ownership, timeline and status queries.
-- Safe to apply on existing data; no business rules are changed here.

CREATE INDEX IF NOT EXISTS idx_leads_status_created_at
  ON leads(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_followup_salesman
  ON leads(next_follow_up_date, salesman_id)
  WHERE next_follow_up_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_location_pings_salesman_captured
  ON location_pings(salesman_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_salesman_created
  ON notifications(salesman_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user
  ON push_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_entity_timeline
  ON activity_logs(entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_events_task_created
  ON task_events(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_day_closing_user_day
  ON day_closing_reports(user_id, day DESC);
CREATE INDEX IF NOT EXISTS idx_visits_salesman_arrived
  ON visits(salesman_id, arrived_at DESC);
CREATE INDEX IF NOT EXISTS idx_quotation_owner_updated
  ON quotations(owner_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_quotation_events_timeline
  ON quotation_events(quote_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_collection_accounts_lead
  ON collection_accounts(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_payments_lead_paid
  ON lead_payments(lead_id, paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_exception_cases_status_updated
  ON exception_cases(status, active, updated_at DESC);
