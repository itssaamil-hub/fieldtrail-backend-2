ALTER TABLE collection_accounts
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archive_reason TEXT;

ALTER TABLE collection_accounts
  DROP CONSTRAINT IF EXISTS collection_accounts_archive_reason_check;
ALTER TABLE collection_accounts
  ADD CONSTRAINT collection_accounts_archive_reason_check
  CHECK (archive_reason IS NULL OR char_length(btrim(archive_reason)) BETWEEN 5 AND 500);

CREATE INDEX IF NOT EXISTS collection_accounts_archived_idx
  ON collection_accounts(archived_at) WHERE archived_at IS NOT NULL;

CREATE OR REPLACE FUNCTION sync_payment_account_archive_from_lead_status()
RETURNS trigger AS $$
BEGIN
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'won' AND NEW.status <> 'won' THEN
    UPDATE collection_accounts
       SET archived_at = COALESCE(archived_at, now()),
           archive_reason = 'Deal moved from Won to ' || NEW.status,
           version = version + 1
     WHERE lead_id = NEW.id
       AND voided_at IS NULL
       AND archived_at IS NULL;
  ELSIF NEW.status = 'won' THEN
    UPDATE collection_accounts
       SET archived_at = NULL,
           archive_reason = NULL,
           version = version + 1
     WHERE lead_id = NEW.id
       AND voided_at IS NULL
       AND archived_at IS NOT NULL;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payment_account_archive_from_lead_status ON leads;
CREATE TRIGGER trg_payment_account_archive_from_lead_status
AFTER UPDATE OF status ON leads
FOR EACH ROW
EXECUTE FUNCTION sync_payment_account_archive_from_lead_status();
