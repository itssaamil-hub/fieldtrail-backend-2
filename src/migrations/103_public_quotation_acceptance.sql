CREATE TABLE quotation_public_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id UUID NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  first_viewed_at TIMESTAMPTZ,
  last_viewed_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (quote_id, revision) REFERENCES quotation_revisions(quote_id, revision) ON DELETE CASCADE
);

CREATE UNIQUE INDEX quotation_public_links_one_active
  ON quotation_public_links(quote_id, revision)
  WHERE revoked_at IS NULL;
CREATE INDEX quotation_public_links_quote_revision
  ON quotation_public_links(quote_id, revision, created_at DESC);

CREATE TABLE quotation_public_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id UUID NOT NULL,
  revision INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('accepted','changes_requested')),
  customer_name TEXT NOT NULL CHECK (char_length(btrim(customer_name)) BETWEEN 2 AND 180),
  designation TEXT NOT NULL DEFAULT '' CHECK (char_length(designation) <= 120),
  email TEXT NOT NULL DEFAULT '' CHECK (char_length(email) <= 254),
  phone TEXT NOT NULL DEFAULT '' CHECK (char_length(phone) <= 30),
  message TEXT NOT NULL DEFAULT '' CHECK (char_length(message) <= 1500),
  ip_address TEXT NOT NULL DEFAULT '' CHECK (char_length(ip_address) <= 100),
  user_agent TEXT NOT NULL DEFAULT '' CHECK (char_length(user_agent) <= 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (quote_id, revision) REFERENCES quotation_revisions(quote_id, revision) ON DELETE CASCADE,
  UNIQUE (quote_id, revision)
);
CREATE INDEX quotation_public_responses_created
  ON quotation_public_responses(created_at DESC);

ALTER TABLE quotation_alerts DROP CONSTRAINT IF EXISTS quotation_alerts_kind_check;
ALTER TABLE quotation_alerts
  ADD CONSTRAINT quotation_alerts_kind_check
  CHECK (kind IN ('approval','approved','changes_requested','follow_up','accepted'));
