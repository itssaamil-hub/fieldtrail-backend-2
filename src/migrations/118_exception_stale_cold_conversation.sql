ALTER TABLE exception_settings
  ADD COLUMN IF NOT EXISTS cold_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS cold_stale_days INTEGER NOT NULL DEFAULT 3 CHECK (cold_stale_days BETWEEN 1 AND 90),
  ADD COLUMN IF NOT EXISTS cold_critical_days INTEGER NOT NULL DEFAULT 5 CHECK (cold_critical_days BETWEEN 1 AND 180),
  ADD COLUMN IF NOT EXISTS conversation_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS conversation_stale_days INTEGER NOT NULL DEFAULT 3 CHECK (conversation_stale_days BETWEEN 1 AND 90),
  ADD COLUMN IF NOT EXISTS conversation_critical_days INTEGER NOT NULL DEFAULT 5 CHECK (conversation_critical_days BETWEEN 1 AND 180);
