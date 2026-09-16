CREATE TABLE IF NOT EXISTS notification_read_state (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  activity_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  activity_seen_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  briefing_seen_day DATE
);
-- Historical activity remains visible, but does not produce an initial huge badge.
INSERT INTO notification_read_state (user_id) SELECT id FROM users ON CONFLICT DO NOTHING;
