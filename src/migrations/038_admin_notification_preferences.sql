ALTER TABLE notification_preferences
  ADD COLUMN IF NOT EXISTS deal_won boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS target_milestone boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS day_started_ended boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS day_closing_missing boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS day_activity_summary boolean NOT NULL DEFAULT true;
