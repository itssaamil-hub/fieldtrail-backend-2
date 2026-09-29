ALTER TABLE attendance
  ADD COLUMN IF NOT EXISTS start_accuracy_m numeric,
  ADD COLUMN IF NOT EXISTS start_fix_timestamp timestamptz,
  ADD COLUMN IF NOT EXISTS start_location_source text,
  ADD COLUMN IF NOT EXISTS start_low_accuracy boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS end_accuracy_m numeric,
  ADD COLUMN IF NOT EXISTS end_fix_timestamp timestamptz,
  ADD COLUMN IF NOT EXISTS end_location_source text,
  ADD COLUMN IF NOT EXISTS end_low_accuracy boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  ALTER TABLE attendance
    ADD CONSTRAINT attendance_start_location_source_check
    CHECK (start_location_source IS NULL OR start_location_source IN ('cached','fresh','fallback'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE attendance
    ADD CONSTRAINT attendance_end_location_source_check
    CHECK (end_location_source IS NULL OR end_location_source IN ('cached','fresh','fallback'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE attendance
    ADD CONSTRAINT attendance_start_accuracy_nonnegative
    CHECK (start_accuracy_m IS NULL OR start_accuracy_m >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE attendance
    ADD CONSTRAINT attendance_end_accuracy_nonnegative
    CHECK (end_accuracy_m IS NULL OR end_accuracy_m >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
