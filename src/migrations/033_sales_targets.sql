CREATE TABLE IF NOT EXISTS sales_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salesman_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month date NOT NULL,
  leads_target integer NOT NULL DEFAULT 0 CHECK (leads_target >= 0),
  visits_target integer NOT NULL DEFAULT 0 CHECK (visits_target >= 0),
  demos_target integer NOT NULL DEFAULT 0 CHECK (demos_target >= 0),
  won_target integer NOT NULL DEFAULT 0 CHECK (won_target >= 0),
  sales_value_target numeric(14,2) NOT NULL DEFAULT 0 CHECK (sales_value_target >= 0),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (salesman_id, month)
);
CREATE INDEX IF NOT EXISTS sales_targets_month_idx ON sales_targets(month);
