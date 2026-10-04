ALTER TABLE collection_accounts
  ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS void_reason TEXT,
  ADD COLUMN IF NOT EXISTS voided_by UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE quotations
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancel_reason TEXT,
  ADD COLUMN IF NOT EXISTS cancelled_by UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE collection_accounts
  DROP CONSTRAINT IF EXISTS collection_accounts_void_reason_check;
ALTER TABLE collection_accounts
  ADD CONSTRAINT collection_accounts_void_reason_check
  CHECK (void_reason IS NULL OR char_length(btrim(void_reason)) BETWEEN 5 AND 500);

ALTER TABLE quotations
  DROP CONSTRAINT IF EXISTS quotations_cancel_reason_check;
ALTER TABLE quotations
  ADD CONSTRAINT quotations_cancel_reason_check
  CHECK (cancel_reason IS NULL OR char_length(btrim(cancel_reason)) BETWEEN 5 AND 500);

CREATE INDEX IF NOT EXISTS collection_accounts_voided_idx
  ON collection_accounts(voided_at) WHERE voided_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS quotations_cancelled_idx
  ON quotations(cancelled_at) WHERE cancelled_at IS NOT NULL;
