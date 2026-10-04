CREATE TABLE IF NOT EXISTS quotation_deletion_audit (
  id BIGSERIAL PRIMARY KEY,
  quote_id UUID NOT NULL,
  quote_number BIGINT,
  revision INTEGER NOT NULL,
  customer_name TEXT,
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  deleted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  financial_activity_found BOOLEAN NOT NULL DEFAULT false,
  snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT quotation_deletion_audit_reason_check
    CHECK (char_length(btrim(reason)) BETWEEN 5 AND 500)
);

CREATE UNIQUE INDEX IF NOT EXISTS quotation_deletion_audit_quote_uidx
  ON quotation_deletion_audit(quote_id);
CREATE INDEX IF NOT EXISTS quotation_deletion_audit_deleted_at_idx
  ON quotation_deletion_audit(deleted_at DESC);
