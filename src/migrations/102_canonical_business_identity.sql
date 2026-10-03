CREATE OR REPLACE FUNCTION enforce_canonical_business_name()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  canonical_name text;
BEGIN
  SELECT business_name INTO canonical_name
  FROM public.business_profile
  WHERE id = 1;

  IF canonical_name IS NOT NULL AND btrim(canonical_name) <> '' THEN
    NEW.config = jsonb_set(
      COALESCE(NEW.config, '{}'::jsonb),
      '{company}',
      to_jsonb(canonical_name),
      true
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS quotation_settings_canonical_business_name ON quotation_settings;
CREATE TRIGGER quotation_settings_canonical_business_name
BEFORE INSERT OR UPDATE OF config ON quotation_settings
FOR EACH ROW
EXECUTE FUNCTION enforce_canonical_business_name();
