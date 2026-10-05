-- Manual payment-account voiding is retired. A Won Deal must own one active
-- canonical account, including legacy records that were voided before retirement.

UPDATE collection_accounts a
   SET voided_at = NULL,
       voided_by = NULL,
       void_reason = NULL,
       archived_at = NULL,
       archive_reason = NULL,
       version = version + 1
  FROM leads l
 WHERE a.lead_id = l.id
   AND l.status = 'won'
   AND a.voided_at IS NOT NULL;

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
      voided_at = NULL,
      voided_by = NULL,
      void_reason = NULL,
      version = collection_accounts.version + 1;
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
