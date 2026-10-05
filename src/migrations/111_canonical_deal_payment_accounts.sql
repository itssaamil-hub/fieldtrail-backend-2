-- One canonical payment account per Deal. Quotations no longer create/control accounts.

-- Preserve historical quote display fields if present, but remove the live FK link.
UPDATE collection_accounts SET quote_id = NULL WHERE quote_id IS NOT NULL;

CREATE OR REPLACE FUNCTION sync_payment_account_archive_from_lead_status()
RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'won' THEN
    INSERT INTO collection_accounts(
      lead_id, owner_id, customer, snapshot, total, currency,
      archived_at, archive_reason
    ) VALUES (
      NEW.id,
      NEW.salesman_id,
      jsonb_build_object(
        'name', NEW.business_name,
        'contact', NEW.contact_name,
        'phone', NEW.phone
      ),
      '{}'::jsonb,
      COALESCE(NEW.deal_value, 0),
      'INR',
      NULL,
      NULL
    )
    ON CONFLICT (lead_id) DO UPDATE SET
      owner_id = EXCLUDED.owner_id,
      customer = EXCLUDED.customer,
      total = EXCLUDED.total,
      archived_at = NULL,
      archive_reason = NULL,
      version = collection_accounts.version + 1
    WHERE collection_accounts.voided_at IS NULL;
  ELSIF TG_OP = 'UPDATE' AND OLD.status = 'won' AND NEW.status <> 'won' THEN
    UPDATE collection_accounts
       SET archived_at = COALESCE(archived_at, now()),
           archive_reason = 'Deal moved from Won to ' || NEW.status,
           version = version + 1
     WHERE lead_id = NEW.id
       AND voided_at IS NULL
       AND archived_at IS NULL;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payment_account_archive_from_lead_status ON leads;
DROP TRIGGER IF EXISTS trg_payment_account_create_on_won_insert ON leads;

CREATE TRIGGER trg_payment_account_create_on_won_insert
AFTER INSERT ON leads
FOR EACH ROW
EXECUTE FUNCTION sync_payment_account_archive_from_lead_status();

CREATE TRIGGER trg_payment_account_archive_from_lead_status
AFTER UPDATE OF status ON leads
FOR EACH ROW
EXECUTE FUNCTION sync_payment_account_archive_from_lead_status();

-- Backfill existing Won Deals that previously existed only as virtual lead:<id> accounts.
INSERT INTO collection_accounts(
  lead_id, owner_id, customer, snapshot, total, currency,
  archived_at, archive_reason
)
SELECT
  l.id,
  l.salesman_id,
  jsonb_build_object(
    'name', l.business_name,
    'contact', l.contact_name,
    'phone', l.phone
  ),
  '{}'::jsonb,
  COALESCE(l.deal_value, 0),
  'INR',
  NULL,
  NULL
FROM leads l
WHERE l.status = 'won'
  AND NOT EXISTS (
    SELECT 1 FROM collection_accounts a WHERE a.lead_id = l.id
  );
