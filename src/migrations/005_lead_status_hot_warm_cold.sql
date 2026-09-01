-- New quick-classification statuses for the salesman's Add Lead form.
-- ALTER TYPE ... ADD VALUE can't run directly inside a DO block/PL/pgSQL —
-- it must go through EXECUTE with dynamic SQL. Guarded against pg_enum so
-- this migration is safe to re-run.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'hot' AND enumtypid = 'lead_status'::regtype) THEN
    EXECUTE 'ALTER TYPE lead_status ADD VALUE ''hot''';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'warm' AND enumtypid = 'lead_status'::regtype) THEN
    EXECUTE 'ALTER TYPE lead_status ADD VALUE ''warm''';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'cold' AND enumtypid = 'lead_status'::regtype) THEN
    EXECUTE 'ALTER TYPE lead_status ADD VALUE ''cold''';
  END IF;
END$$;
