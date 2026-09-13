-- Business expenses (salary, travel, fuel, food, etc). Optionally linked to
-- a salesman (e.g. for salary payouts), but not required — general office
-- expenses can be logged with no salesman attached.
CREATE TABLE expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category TEXT NOT NULL,
  amount NUMERIC NOT NULL CHECK (amount > 0),
  salesman_id UUID REFERENCES users(id),
  note TEXT,
  spent_on DATE NOT NULL DEFAULT CURRENT_DATE,
  recorded_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_expenses_spent_on ON expenses(spent_on);
CREATE INDEX idx_expenses_salesman_id ON expenses(salesman_id);
