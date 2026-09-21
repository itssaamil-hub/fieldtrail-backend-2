CREATE TABLE IF NOT EXISTS sales_targets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 salesman_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 month date NOT NULL,
 updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(salesman_id,month)
);
ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS leads_target integer NOT NULL DEFAULT 0;
ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS visits_target integer NOT NULL DEFAULT 0;
ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS demos_target integer NOT NULL DEFAULT 0;
ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS won_target integer NOT NULL DEFAULT 0;
ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS sales_value_target numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS visits_incentive numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS leads_incentive numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS demos_incentive numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS won_incentive numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS sales_value_incentive_pct numeric(7,3) NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS sales_targets_month_idx ON sales_targets(month);
