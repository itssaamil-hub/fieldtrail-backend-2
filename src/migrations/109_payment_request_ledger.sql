CREATE TABLE IF NOT EXISTS payment_request_ledger (
  recorded_by UUID NOT NULL REFERENCES users(id),
  request_id UUID NOT NULL,
  account_id UUID REFERENCES collection_accounts(id) ON DELETE SET NULL,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  payment_id UUID REFERENCES lead_payments(id) ON DELETE SET NULL,
  amount NUMERIC NOT NULL CHECK (amount > 0),
  payment_date DATE NOT NULL,
  method TEXT NOT NULL CHECK(method IN ('unspecified','upi','bank','cash','cheque','card','other')),
  reference TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(recorded_by,request_id)
);

INSERT INTO payment_request_ledger(recorded_by,request_id,account_id,lead_id,payment_id,amount,payment_date,method,reference,note)
SELECT p.recorded_by,p.request_id,p.account_id,p.lead_id,p.id,p.amount,(p.paid_at AT TIME ZONE 'Asia/Kolkata')::date,p.method,COALESCE(p.reference,''),COALESCE(p.note,'')
FROM lead_payments p
WHERE p.request_id IS NOT NULL
ON CONFLICT(recorded_by,request_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS payment_request_ledger_payment_idx ON payment_request_ledger(payment_id);
CREATE INDEX IF NOT EXISTS payment_request_ledger_account_idx ON payment_request_ledger(account_id);
