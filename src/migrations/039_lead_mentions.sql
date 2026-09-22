-- Admin-to-salesman lead mentions. Reuses the existing Messages inbox while
-- keeping a durable link back to the lead.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS lead_id UUID REFERENCES leads(id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_type TEXT NOT NULL DEFAULT 'general';
CREATE INDEX IF NOT EXISTS idx_messages_lead ON messages (lead_id, created_at DESC) WHERE lead_id IS NOT NULL;
