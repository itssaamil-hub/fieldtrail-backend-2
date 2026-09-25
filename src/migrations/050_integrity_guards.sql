-- Enforce sane values for new/changed rows without blocking deployment on
-- legacy data. NOT VALID skips the historical scan but still protects future writes.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='leads_deal_value_nonnegative') THEN
    ALTER TABLE leads ADD CONSTRAINT leads_deal_value_nonnegative
      CHECK (deal_value IS NULL OR deal_value >= 0) NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='lead_payments_amount_positive') THEN
    ALTER TABLE lead_payments ADD CONSTRAINT lead_payments_amount_positive
      CHECK (amount > 0) NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='expenses_amount_positive') THEN
    ALTER TABLE expenses ADD CONSTRAINT expenses_amount_positive
      CHECK (amount > 0) NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='collection_accounts_total_nonnegative') THEN
    ALTER TABLE collection_accounts ADD CONSTRAINT collection_accounts_total_nonnegative
      CHECK (total >= 0) NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='attendance_end_after_start') THEN
    ALTER TABLE attendance ADD CONSTRAINT attendance_end_after_start
      CHECK (end_day_at IS NULL OR start_day_at IS NULL OR end_day_at >= start_day_at) NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='leads_latitude_range') THEN
    ALTER TABLE leads ADD CONSTRAINT leads_latitude_range
      CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='leads_longitude_range') THEN
    ALTER TABLE leads ADD CONSTRAINT leads_longitude_range
      CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180) NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='location_pings_latitude_range') THEN
    ALTER TABLE location_pings ADD CONSTRAINT location_pings_latitude_range
      CHECK (latitude BETWEEN -90 AND 90) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='location_pings_longitude_range') THEN
    ALTER TABLE location_pings ADD CONSTRAINT location_pings_longitude_range
      CHECK (longitude BETWEEN -180 AND 180) NOT VALID;
  END IF;
END $$;
