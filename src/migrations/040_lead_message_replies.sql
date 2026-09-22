-- Two-way lead message threads and global employee reply control.
-- Additive only: preserves all existing messages and CRM settings.
ALTER TABLE crm_settings
  ADD COLUMN IF NOT EXISTS message_settings JSONB NOT NULL DEFAULT '{"employeeRepliesEnabled": true}'::jsonb;

UPDATE crm_settings
SET message_settings = COALESCE(message_settings, '{}'::jsonb) || '{"employeeRepliesEnabled": true}'::jsonb
WHERE NOT (COALESCE(message_settings, '{}'::jsonb) ? 'employeeRepliesEnabled');

ALTER TABLE messages ADD COLUMN IF NOT EXISTS parent_message_id UUID REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS thread_root_id UUID REFERENCES messages(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages (thread_root_id, created_at ASC) WHERE thread_root_id IS NOT NULL;
