ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS sales_briefing BOOLEAN NOT NULL DEFAULT true;
CREATE TABLE IF NOT EXISTS sales_briefing_deliveries (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day)
);
