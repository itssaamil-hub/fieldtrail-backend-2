-- Reusable monthly incentive rule, configured once per employee/year.
-- Monthly thresholds come from sales_targets; only Won and Sales Value earn incentives.
ALTER TABLE sales_incentive_plans
  ADD COLUMN IF NOT EXISTS deals_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sales_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN sales_incentive_plans.deal_extra_amount IS
  'Amount paid per deal above that month''s won_target';
COMMENT ON COLUMN sales_incentive_plans.sales_value_extra_pct IS
  'Percent paid on sales value above that month''s sales_value_target';
