-- Scheduled-job idempotency ledger.
-- Prevents cron-job.org retries or double clicks from sending the same daily
-- reminder/digest more than once. Failed/stale runs can still be retried.

CREATE TABLE IF NOT EXISTS scheduled_job_runs (
  job_name TEXT NOT NULL,
  run_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','done','failed')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  result JSONB,
  error TEXT,
  PRIMARY KEY (job_name, run_key)
);

CREATE INDEX IF NOT EXISTS idx_scheduled_job_runs_started
  ON scheduled_job_runs(started_at DESC);
