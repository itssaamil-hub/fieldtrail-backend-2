CREATE OR REPLACE FUNCTION enforce_payment_write_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_account_id uuid;
  v_account_lead_id uuid;
  v_lead_id uuid;
  v_archived_at timestamptz;
  v_voided_at timestamptz;
  v_status text;
BEGIN
  -- Permanent Deal purge is an explicit admin-only application transaction.
  -- Keep ordinary payment deletes protected; only the transaction-local flag
  -- may bypass lifecycle checks so related financial rows can be removed atomically.
  IF TG_OP = 'DELETE' AND current_setting('app.deal_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' AND NEW.request_id IS NULL THEN
    RAISE EXCEPTION 'payment request identifier required' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_account_id := OLD.account_id;
    v_lead_id := OLD.lead_id;
  ELSE
    v_account_id := NEW.account_id;
    v_lead_id := NEW.lead_id;
  END IF;

  IF v_account_id IS NOT NULL THEN
    SELECT lead_id, archived_at, voided_at
      INTO v_account_lead_id, v_archived_at, v_voided_at
      FROM collection_accounts
     WHERE id = v_account_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'payment account not found' USING ERRCODE = '23514';
    END IF;

    v_lead_id := COALESCE(v_lead_id, v_account_lead_id);
  ELSIF v_lead_id IS NOT NULL THEN
    SELECT archived_at, voided_at
      INTO v_archived_at, v_voided_at
      FROM collection_accounts
     WHERE lead_id = v_lead_id;
  END IF;

  IF v_archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'archived payment account is read only' USING ERRCODE = '23514';
  END IF;

  IF v_voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'voided payment account is read only' USING ERRCODE = '23514';
  END IF;

  IF v_lead_id IS NULL THEN
    RAISE EXCEPTION 'payment must reference a Deal' USING ERRCODE = '23514';
  END IF;

  SELECT status INTO v_status FROM leads WHERE id = v_lead_id;
  IF v_status IS DISTINCT FROM 'won' THEN
    RAISE EXCEPTION 'linked Deal must be Won for payment writes' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS lead_payments_write_integrity ON lead_payments;
CREATE TRIGGER lead_payments_write_integrity
BEFORE INSERT OR UPDATE OR DELETE ON lead_payments
FOR EACH ROW EXECUTE FUNCTION enforce_payment_write_integrity();
