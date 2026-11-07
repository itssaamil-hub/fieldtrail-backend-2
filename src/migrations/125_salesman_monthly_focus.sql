-- Employee-owned monthly focus list. Does not change leads, statuses, attendance, or activity history.
CREATE TABLE IF NOT EXISTS salesman_monthly_focus (
  salesman_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month_start DATE NOT NULL,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (salesman_id, month_start, lead_id),
  CONSTRAINT salesman_monthly_focus_first_day CHECK (EXTRACT(DAY FROM month_start) = 1)
);
CREATE INDEX IF NOT EXISTS salesman_monthly_focus_lead_idx ON salesman_monthly_focus (lead_id);
-- These rows must only be read/written by authenticated Express routes which check lead ownership.
ALTER TABLE salesman_monthly_focus ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON salesman_monthly_focus FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON salesman_monthly_focus FROM anon; END IF;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON salesman_monthly_focus FROM authenticated; END IF;
END $$;
