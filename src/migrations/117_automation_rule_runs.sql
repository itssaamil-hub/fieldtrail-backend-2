-- Idempotency ledger for lead automation actions.
-- One inactive-lead task is created for a specific inactivity episode; scheduler
-- retries and later daily runs cannot duplicate it until the lead has new activity.

CREATE TABLE IF NOT EXISTS automation_rule_runs (
  rule_key TEXT NOT NULL,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  activity_anchor TIMESTAMPTZ NOT NULL,
  task_id UUID REFERENCES crm_tasks(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (rule_key, lead_id, activity_anchor)
);

CREATE INDEX IF NOT EXISTS idx_automation_rule_runs_created
  ON automation_rule_runs(created_at DESC);
