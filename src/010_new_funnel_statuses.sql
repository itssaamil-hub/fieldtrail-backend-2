DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'conversation' AND enumtypid = 'lead_status'::regtype) THEN
    EXECUTE 'ALTER TYPE lead_status ADD VALUE ''conversation''';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'demo' AND enumtypid = 'lead_status'::regtype) THEN
    EXECUTE 'ALTER TYPE lead_status ADD VALUE ''demo''';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'nurture' AND enumtypid = 'lead_status'::regtype) THEN
    EXECUTE 'ALTER TYPE lead_status ADD VALUE ''nurture''';
  END IF;
END$$;
