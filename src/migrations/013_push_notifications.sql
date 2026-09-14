-- Next follow-up date on a lead, for follow-up reminder notifications.
ALTER TABLE leads ADD COLUMN next_follow_up_date DATE;

-- One row per subscribed device/browser (a user can have several).
CREATE TABLE push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_push_subscriptions_user_id ON push_subscriptions(user_id);

-- Per-user toggle for each notification type. Row is created on first
-- subscribe with sensible defaults (all on); missing row = all defaults.
CREATE TABLE notification_preferences (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  hot_lead BOOLEAN NOT NULL DEFAULT true,
  status_conversation BOOLEAN NOT NULL DEFAULT true,
  status_negotiation BOOLEAN NOT NULL DEFAULT true,
  status_demo BOOLEAN NOT NULL DEFAULT true,
  renewal_due BOOLEAN NOT NULL DEFAULT true,
  follow_up_due BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
