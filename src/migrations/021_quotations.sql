CREATE TABLE quotation_settings (
 id INTEGER PRIMARY KEY CHECK (id=1), version INTEGER NOT NULL DEFAULT 1,
 config JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO quotation_settings(id,config) VALUES(1,'{"company":"Swirl","currency":"INR","prefix":"SW-Q","logo":"","packages":[],"addons":[],"discountLimit":10,"validDays":15,"advancePercent":100,"taxPercent":0,"terms":"Payment due before activation. Renewal terms as agreed.","footer":"Thank you for choosing Swirl.","whatsapp":"Hello, please find our quotation for {restaurant}. Total: {total}. Valid until {expiry}."}');
CREATE TABLE quotations (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), number BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
 owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
 lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
 current_revision INTEGER NOT NULL DEFAULT 1,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE quotation_revisions (
 quote_id UUID NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1,
 snapshot JSONB NOT NULL,
 status TEXT NOT NULL CHECK (status IN ('pending_approval','ready','changes_requested','sent','accepted','rejected')),
 follow_up DATE, expires_on DATE NOT NULL, sent_at TIMESTAMPTZ,
 created_by UUID REFERENCES users(id) ON DELETE SET NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(quote_id,revision)
);
CREATE TABLE quotation_events (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 quote_id UUID NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL, actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
 action TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE quotation_alerts (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 quote_id UUID NOT NULL REFERENCES quotations(id) ON DELETE CASCADE, revision INTEGER NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('approval','approved','changes_requested','follow_up')),
 day DATE NOT NULL DEFAULT ((now() AT TIME ZONE 'Asia/Kolkata')::date), read_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(user_id,quote_id,revision,kind,day)
);
CREATE INDEX quotations_owner ON quotations(owner_id,updated_at DESC);
CREATE INDEX quotation_follow_up ON quotation_revisions(follow_up) WHERE status='sent';
CREATE INDEX quotation_alerts_unread ON quotation_alerts(user_id,created_at DESC) WHERE read_at IS NULL;
