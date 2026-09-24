ALTER TABLE customer_onboarding
  ADD COLUMN IF NOT EXISTS share_token varchar(64),
  ADD COLUMN IF NOT EXISTS share_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS share_created_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS customer_onboarding_share_token_uidx
  ON customer_onboarding(share_token)
  WHERE share_token IS NOT NULL;
