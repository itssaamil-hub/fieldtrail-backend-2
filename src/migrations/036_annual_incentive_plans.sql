-- Annual incentive rules. Incentives apply only to Deals Won and Sales Value.
CREATE TABLE IF NOT EXISTS sales_incentive_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salesman_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_year integer NOT NULL CHECK (plan_year BETWEEN 2020 AND 2100),
  deals_target integer NOT NULL DEFAULT 0 CHECK (deals_target >= 0),
  deal_extra_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (deal_extra_amount >= 0),
  sales_value_target numeric(14,2) NOT NULL DEFAULT 0 CHECK (sales_value_target >= 0),
  sales_value_extra_pct numeric(7,3) NOT NULL DEFAULT 0 CHECK (sales_value_extra_pct >= 0),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (salesman_id, plan_year)
);
CREATE INDEX IF NOT EXISTS sales_incentive_plans_year_idx ON sales_incentive_plans(plan_year);
