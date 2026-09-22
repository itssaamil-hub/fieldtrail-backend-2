-- Soft-delete support for Admin removal of lead-linked conversation messages.
-- Additive only: existing message data and reply/thread relationships are preserved.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_by UUID REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_messages_deleted_at ON messages(deleted_at);
