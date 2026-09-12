-- New sales funnel: Cold → Conversation → Hot → Demo → Negotiation → Won/Lost/Nurture.
-- Old values (new, contacted, follow_up, demo_scheduled, proposal_sent, warm)
-- stay in the enum untouched — existing leads keep whatever status they
-- already have, this only adds the new stages so they become selectable.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'conversation' AND enumtypid = 'lead_status'::regtype) THEN
    EXECUTE 'ALTER TYPE lead_status ADD VALUE ''conversation''';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'demo' AND enumtypid = 'lead_status'::regtype) THEN
    EXECUTE 'ALTER TYPE lead_status ADD VALUE ''demo''';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'nurture' AND enumtypid = 'lead_status'::regtype) THEN
    EXECUTE 'ALTER TYPE lead_status ADD VALUE ''nurture''';
  END IF;
END$$;
