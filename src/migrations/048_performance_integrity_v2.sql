-- Performance/Data Integrity V2
-- First-stage milestones, ownership history and follow-up ledger.
-- Milestone dates/owners are historical; Won sales value intentionally follows
-- the lead's current editable deal_value to preserve Engage's existing flow.

CREATE TABLE IF NOT EXISTS lead_stage_milestones (
  id BIGSERIAL PRIMARY KEY,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK (stage IN ('demo','negotiation','won','lost')),
  salesman_id UUID NOT NULL REFERENCES users(id),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deal_value_snapshot NUMERIC(14,2),
  source TEXT NOT NULL DEFAULT 'trigger',
  UNIQUE (lead_id, stage)
);

CREATE INDEX IF NOT EXISTS idx_lead_stage_milestones_stage_date
  ON lead_stage_milestones(stage, occurred_at);
CREATE INDEX IF NOT EXISTS idx_lead_stage_milestones_salesman_date
  ON lead_stage_milestones(salesman_id, occurred_at);

CREATE TABLE IF NOT EXISTS lead_owner_history (
  id BIGSERIAL PRIMARY KEY,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  salesman_id UUID NOT NULL REFERENCES users(id),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  unassigned_at TIMESTAMPTZ,
  source TEXT NOT NULL DEFAULT 'trigger'
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_lead_owner_history_open
  ON lead_owner_history(lead_id) WHERE unassigned_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_lead_owner_history_lookup
  ON lead_owner_history(lead_id, assigned_at, unassigned_at);
CREATE INDEX IF NOT EXISTS idx_lead_owner_history_salesman
  ON lead_owner_history(salesman_id, assigned_at);

CREATE TABLE IF NOT EXISTS lead_followup_events (
  id BIGSERIAL PRIMARY KEY,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  salesman_id UUID NOT NULL REFERENCES users(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('scheduled','rescheduled','completed')),
  due_from DATE,
  due_to DATE,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source TEXT NOT NULL DEFAULT 'trigger'
);
CREATE INDEX IF NOT EXISTS idx_lead_followup_events_lead_time
  ON lead_followup_events(lead_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_lead_followup_events_salesman_time
  ON lead_followup_events(salesman_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_lead_followup_events_due_to
  ON lead_followup_events(due_to);

INSERT INTO lead_owner_history(lead_id, salesman_id, assigned_at, source)
SELECT l.id, l.salesman_id, l.created_at, 'backfill_current_owner'
FROM leads l
WHERE NOT EXISTS (SELECT 1 FROM lead_owner_history h WHERE h.lead_id=l.id);

INSERT INTO lead_stage_milestones(lead_id, stage, salesman_id, occurred_at, deal_value_snapshot, source)
SELECT DISTINCT ON (h.lead_id, h.new_status::text)
       h.lead_id, h.new_status::text, l.salesman_id, h.changed_at,
       CASE WHEN h.new_status::text='won' THEN l.deal_value ELSE NULL END,
       'backfill_current_owner'
FROM lead_status_history h
JOIN leads l ON l.id=h.lead_id
WHERE h.new_status::text IN ('demo','negotiation','won','lost')
ORDER BY h.lead_id, h.new_status::text, h.changed_at
ON CONFLICT (lead_id, stage) DO NOTHING;

INSERT INTO lead_stage_milestones(lead_id, stage, salesman_id, occurred_at, deal_value_snapshot, source)
SELECT DISTINCT ON (a.entity_id, a.metadata->>'to')
       a.entity_id, a.metadata->>'to', l.salesman_id, a.created_at,
       CASE WHEN a.metadata->>'to'='won' THEN l.deal_value ELSE NULL END,
       'backfill_current_owner'
FROM activity_logs a
JOIN leads l ON l.id=a.entity_id
WHERE a.entity_type='lead' AND a.action='lead.status_changed'
  AND a.metadata->>'to' IN ('demo','negotiation','won','lost')
ORDER BY a.entity_id, a.metadata->>'to', a.created_at
ON CONFLICT (lead_id, stage) DO NOTHING;

-- Make sure an existing Won milestone always starts with the current value.
UPDATE lead_stage_milestones m
SET deal_value_snapshot=l.deal_value
FROM leads l
WHERE m.lead_id=l.id AND m.stage='won'
  AND m.deal_value_snapshot IS DISTINCT FROM l.deal_value;

INSERT INTO lead_followup_events(lead_id, salesman_id, event_type, due_to, occurred_at, source)
SELECT l.id, l.salesman_id, 'scheduled', l.next_follow_up_date, l.created_at, 'backfill_current_state'
FROM leads l
WHERE l.next_follow_up_date IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM lead_followup_events f WHERE f.lead_id=l.id);

CREATE OR REPLACE FUNCTION engage_capture_lead_integrity_v2()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  st TEXT;
BEGIN
  IF TG_OP='INSERT' THEN
    INSERT INTO lead_owner_history(lead_id,salesman_id,assigned_at,source)
    VALUES(NEW.id,NEW.salesman_id,COALESCE(NEW.created_at,now()),'trigger')
    ON CONFLICT DO NOTHING;
  ELSIF NEW.salesman_id IS DISTINCT FROM OLD.salesman_id THEN
    UPDATE lead_owner_history SET unassigned_at=now()
      WHERE lead_id=NEW.id AND unassigned_at IS NULL;
    INSERT INTO lead_owner_history(lead_id,salesman_id,assigned_at,source)
    VALUES(NEW.id,NEW.salesman_id,now(),'trigger');
  END IF;

  st := NEW.status::text;
  IF st IN ('demo','negotiation','won','lost')
     AND (TG_OP='INSERT' OR NEW.status IS DISTINCT FROM OLD.status) THEN
    INSERT INTO lead_stage_milestones(lead_id,stage,salesman_id,occurred_at,deal_value_snapshot,source)
    VALUES(NEW.id,st,NEW.salesman_id,now(),CASE WHEN st='won' THEN NEW.deal_value ELSE NULL END,'trigger')
    ON CONFLICT (lead_id,stage) DO NOTHING;
  END IF;

  -- Engage intentionally keeps Deal Value editable after Won. Sync only the
  -- value used by reporting; do not create another Won milestone/event.
  IF TG_OP='UPDATE' AND NEW.deal_value IS DISTINCT FROM OLD.deal_value THEN
    UPDATE lead_stage_milestones
    SET deal_value_snapshot=NEW.deal_value
    WHERE lead_id=NEW.id AND stage='won';
  END IF;

  IF TG_OP='INSERT' THEN
    IF NEW.next_follow_up_date IS NOT NULL THEN
      INSERT INTO lead_followup_events(lead_id,salesman_id,event_type,due_to,occurred_at,source)
      VALUES(NEW.id,NEW.salesman_id,'scheduled',NEW.next_follow_up_date,COALESCE(NEW.created_at,now()),'trigger');
    END IF;
  ELSIF NEW.next_follow_up_date IS DISTINCT FROM OLD.next_follow_up_date THEN
    INSERT INTO lead_followup_events(lead_id,salesman_id,event_type,due_from,due_to,occurred_at,source)
    VALUES(
      NEW.id, NEW.salesman_id,
      CASE
        WHEN OLD.next_follow_up_date IS NULL THEN 'scheduled'
        WHEN NEW.next_follow_up_date IS NULL THEN 'completed'
        ELSE 'rescheduled'
      END,
      OLD.next_follow_up_date, NEW.next_follow_up_date, now(), 'trigger'
    );
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_engage_lead_integrity_v2 ON leads;
CREATE TRIGGER trg_engage_lead_integrity_v2
AFTER INSERT OR UPDATE OF status, salesman_id, next_follow_up_date, deal_value ON leads
FOR EACH ROW EXECUTE FUNCTION engage_capture_lead_integrity_v2();

CREATE INDEX IF NOT EXISTS idx_leads_salesman_created_at ON leads(salesman_id, created_at);
CREATE INDEX IF NOT EXISTS idx_activity_logs_action_created ON activity_logs(action, created_at);
CREATE INDEX IF NOT EXISTS idx_attendance_salesman_day ON attendance(salesman_id, day);
CREATE INDEX IF NOT EXISTS idx_crm_tasks_assigned_due ON crm_tasks(assigned_to, due_at);
CREATE INDEX IF NOT EXISTS idx_lead_payments_paid_at ON lead_payments(paid_at);
