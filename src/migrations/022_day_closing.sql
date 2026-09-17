CREATE TABLE employee_day_closing_permissions (
 user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 require_closing BOOLEAN NOT NULL DEFAULT false,
 allow_skip BOOLEAN NOT NULL DEFAULT false,
 require_skip_reason BOOLEAN NOT NULL DEFAULT true,
 version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE day_closing_reports (
 attendance_id UUID PRIMARY KEY REFERENCES attendance(id) ON DELETE CASCADE,
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 day DATE NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('draft','submitted','skipped','not_required')),
 outcomes TEXT NOT NULL DEFAULT '', blockers TEXT NOT NULL DEFAULT '', priorities TEXT NOT NULL DEFAULT '',
 skip_reason TEXT NOT NULL DEFAULT '', metrics JSONB NOT NULL DEFAULT '{}',
 permissions JSONB NOT NULL DEFAULT '{}',version INTEGER NOT NULL DEFAULT 1,
 submitted_at TIMESTAMPTZ,updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX day_closing_user_day ON day_closing_reports(user_id,day DESC);
