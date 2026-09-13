-- Tracks individual payments recorded against a Won lead's deal_value.
-- Pending amount is always derived (deal_value - SUM(amount)) rather than
-- stored, so it can never drift out of sync with the actual payment log.
CREATE TABLE lead_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  amount NUMERIC NOT NULL CHECK (amount > 0),
  note TEXT,
  recorded_by UUID NOT NULL REFERENCES users(id),
  paid_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_lead_payments_lead_id ON lead_payments(lead_id);
