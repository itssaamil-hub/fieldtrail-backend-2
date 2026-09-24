ALTER TABLE crm_tasks DROP CONSTRAINT IF EXISTS crm_tasks_status_check;
ALTER TABLE crm_tasks ADD CONSTRAINT crm_tasks_status_check CHECK (status IN ('pending','in_progress','completed'));
ALTER TABLE crm_tasks ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('high','medium','low'));
ALTER TABLE crm_tasks ADD COLUMN IF NOT EXISTS recurrence TEXT NOT NULL DEFAULT 'none' CHECK (recurrence IN ('none','daily','weekly','monthly'));
ALTER TABLE crm_tasks ADD COLUMN IF NOT EXISTS recurrence_day INTEGER CHECK (recurrence_day BETWEEN 1 AND 31);
ALTER TABLE crm_tasks ADD COLUMN IF NOT EXISTS repeat_of UUID REFERENCES crm_tasks(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS crm_tasks_repeat_once ON crm_tasks(repeat_of) WHERE repeat_of IS NOT NULL;
CREATE TABLE IF NOT EXISTS task_events (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 task_id UUID NOT NULL REFERENCES crm_tasks(id) ON DELETE CASCADE,
 actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
 action TEXT NOT NULL,
 old_value TEXT,
 new_value TEXT,
 reason TEXT NOT NULL DEFAULT '',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS task_events_timeline ON task_events(task_id,created_at,id);
