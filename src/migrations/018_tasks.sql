CREATE TABLE IF NOT EXISTS crm_tasks (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 180),
 notes TEXT NOT NULL DEFAULT '',
 lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
 assigned_to UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created_by UUID REFERENCES users(id) ON DELETE SET NULL,
 due_at TIMESTAMPTZ NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed')),
 completion_note TEXT NOT NULL DEFAULT '',
 completed_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_tasks_assignee_due ON crm_tasks(assigned_to,status,due_at);
CREATE INDEX IF NOT EXISTS crm_tasks_due ON crm_tasks(status,due_at);
CREATE TABLE IF NOT EXISTS task_notifications (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 task_id UUID NOT NULL REFERENCES crm_tasks(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK (kind IN ('assigned','reminder')),
 day DATE NOT NULL DEFAULT CURRENT_DATE,
 read_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(user_id,task_id,kind,day)
);
CREATE INDEX IF NOT EXISTS task_notifications_unread ON task_notifications(user_id,created_at DESC) WHERE read_at IS NULL;
