-- Additive integrity guards that preserve existing behaviour while protecting
-- future writes. NOT VALID avoids blocking deployment on legacy rows.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='quotations_current_revision_positive') THEN
    ALTER TABLE quotations ADD CONSTRAINT quotations_current_revision_positive
      CHECK (current_revision >= 1) NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='quotation_revisions_revision_positive') THEN
    ALTER TABLE quotation_revisions ADD CONSTRAINT quotation_revisions_revision_positive
      CHECK (revision >= 1 AND version >= 1) NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='quotation_events_revision_positive') THEN
    ALTER TABLE quotation_events ADD CONSTRAINT quotation_events_revision_positive
      CHECK (revision >= 1) NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='messages_body_not_blank') THEN
    ALTER TABLE messages ADD CONSTRAINT messages_body_not_blank
      CHECK (length(btrim(body)) > 0) NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='messages_not_self_parent') THEN
    ALTER TABLE messages ADD CONSTRAINT messages_not_self_parent
      CHECK (parent_message_id IS NULL OR parent_message_id <> id) NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_quotation_events_quote_revision
  ON quotation_events(quote_id, revision, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quotation_revisions_quote_status
  ON quotation_revisions(quote_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_lead_thread
  ON messages(lead_id, created_at DESC) WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_sender_recipient
  ON messages(sender_id, recipient_id, created_at DESC);
