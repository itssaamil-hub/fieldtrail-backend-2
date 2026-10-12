ALTER TABLE notification_preferences
  ADD COLUMN IF NOT EXISTS inactive_lead BOOLEAN NOT NULL DEFAULT true;
