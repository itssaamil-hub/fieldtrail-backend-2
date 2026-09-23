CREATE TABLE collection_accounts (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 lead_id UUID UNIQUE REFERENCES leads(id) ON DELETE CASCADE,
 quote_id UUID UNIQUE REFERENCES quotations(id) ON DELETE SET NULL,
 owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
 customer JSONB NOT NULL, snapshot JSONB NOT NULL DEFAULT '{}',
 quote_number TEXT, quote_revision INTEGER,
 total NUMERIC NOT NULL CHECK(total>=0), currency TEXT NOT NULL CHECK(currency IN ('INR','AED','SAR')),
 due_date DATE, version INTEGER NOT NULL DEFAULT 1,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE lead_payments ALTER COLUMN lead_id DROP NOT NULL;
ALTER TABLE lead_payments ADD COLUMN account_id UUID REFERENCES collection_accounts(id) ON DELETE CASCADE;
ALTER TABLE lead_payments ADD COLUMN method TEXT NOT NULL DEFAULT 'unspecified' CHECK(method IN ('unspecified','upi','bank','cash','cheque','card','other'));
ALTER TABLE lead_payments ADD COLUMN reference TEXT NOT NULL DEFAULT '';
ALTER TABLE lead_payments ADD COLUMN request_id UUID;
ALTER TABLE lead_payments ADD COLUMN receipt_number BIGINT GENERATED ALWAYS AS IDENTITY;
ALTER TABLE lead_payments ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE lead_payments ADD CONSTRAINT payment_account_required CHECK(lead_id IS NOT NULL OR account_id IS NOT NULL);
CREATE UNIQUE INDEX payment_request_unique ON lead_payments(recorded_by,request_id) WHERE request_id IS NOT NULL;
CREATE INDEX payment_account_idx ON lead_payments(account_id);
CREATE INDEX collection_owner_idx ON collection_accounts(owner_id);
CREATE INDEX collection_due_idx ON collection_accounts(due_date);

CREATE UNIQUE INDEX payment_receipt_number_unique ON lead_payments(receipt_number);
