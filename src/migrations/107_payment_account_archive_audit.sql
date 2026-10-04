CREATE OR REPLACE FUNCTION audit_payment_account_archive_from_status_history()
RETURNS trigger AS $$
BEGIN
  IF NEW.old_status = 'won' AND NEW.new_status <> 'won' THEN
    INSERT INTO activity_logs(actor_id,action,entity_type,entity_id,metadata)
    SELECT NEW.changed_by,
           'payment_account.archived',
           'payment_account',
           a.id,
           jsonb_build_object(
             'leadId', NEW.lead_id,
             'fromStatus', NEW.old_status,
             'toStatus', NEW.new_status,
             'state', 'archived'
           )
      FROM collection_accounts a
     WHERE a.lead_id = NEW.lead_id
       AND a.voided_at IS NULL
       AND a.archived_at IS NOT NULL;
  ELSIF NEW.old_status <> 'won' AND NEW.new_status = 'won' THEN
    INSERT INTO activity_logs(actor_id,action,entity_type,entity_id,metadata)
    SELECT NEW.changed_by,
           'payment_account.reactivated',
           'payment_account',
           a.id,
           jsonb_build_object(
             'leadId', NEW.lead_id,
             'fromStatus', NEW.old_status,
             'toStatus', NEW.new_status,
             'state', 'reactivated'
           )
      FROM collection_accounts a
     WHERE a.lead_id = NEW.lead_id
       AND a.voided_at IS NULL
       AND a.archived_at IS NULL;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payment_account_archive_audit ON lead_status_history;
CREATE TRIGGER trg_payment_account_archive_audit
AFTER INSERT ON lead_status_history
FOR EACH ROW
EXECUTE FUNCTION audit_payment_account_archive_from_status_history();
