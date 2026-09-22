ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_by UUID REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_messages_deleted_at ON messages(deleted_at);
