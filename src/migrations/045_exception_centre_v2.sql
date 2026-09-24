-- Exception Centre V2: durable workflow state, history and manager-configurable rules.

CREATE TABLE IF NOT EXISTS exception_cases (
  id BIGSERIAL PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  title TEXT NOT NULL,
  reason TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  entity_name TEXT NOT NULL,
  owner_name TEXT,
  assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','snoozed','resolved')),
  snoozed_until TIMESTAMPTZ,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  resolution_note TEXT,
  reopened_count INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS exception_cases_status_idx ON exception_cases(status, severity, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS exception_cases_assigned_idx ON exception_cases(assigned_to, status);
CREATE INDEX IF NOT EXISTS exception_cases_type_idx ON exception_cases(type, status);

CREATE TABLE IF NOT EXISTS exception_events (
  id BIGSERIAL PRIMARY KEY,
  exception_id BIGINT NOT NULL REFERENCES exception_cases(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  note TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS exception_events_case_idx ON exception_events(exception_id, created_at DESC);

CREATE TABLE IF NOT EXISTS exception_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  followup_enabled BOOLEAN NOT NULL DEFAULT true,
  hot_enabled BOOLEAN NOT NULL DEFAULT true,
  hot_stale_days INTEGER NOT NULL DEFAULT 3 CHECK (hot_stale_days BETWEEN 1 AND 90),
  hot_critical_days INTEGER NOT NULL DEFAULT 5 CHECK (hot_critical_days BETWEEN 1 AND 180),
  negotiation_enabled BOOLEAN NOT NULL DEFAULT true,
  negotiation_stale_days INTEGER NOT NULL DEFAULT 2 CHECK (negotiation_stale_days BETWEEN 1 AND 90),
  negotiation_critical_days INTEGER NOT NULL DEFAULT 5 CHECK (negotiation_critical_days BETWEEN 1 AND 180),
  renewal_enabled BOOLEAN NOT NULL DEFAULT true,
  renewal_warning_days INTEGER NOT NULL DEFAULT 7 CHECK (renewal_warning_days BETWEEN 1 AND 180),
  tasks_enabled BOOLEAN NOT NULL DEFAULT true,
  payments_enabled BOOLEAN NOT NULL DEFAULT true,
  data_quality_enabled BOOLEAN NOT NULL DEFAULT true,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO exception_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
