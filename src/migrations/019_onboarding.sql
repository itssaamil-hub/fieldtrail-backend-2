CREATE TABLE IF NOT EXISTS onboarding_template (
 id INTEGER PRIMARY KEY CHECK (id=1),
 version INTEGER NOT NULL DEFAULT 1,
 steps JSONB NOT NULL CHECK (jsonb_typeof(steps)='array'),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO onboarding_template(id,steps) VALUES(1,'[
 {"id":"customer","title":"Customer details confirmed"},
 {"id":"payment","title":"Payment recorded"},
 {"id":"menu-collected","title":"Menu collected"},
 {"id":"account","title":"Account created"},
 {"id":"menu-uploaded","title":"Menu uploaded"},
 {"id":"printer","title":"Printer setup tested"},
 {"id":"training","title":"Staff training completed"},
 {"id":"trial","title":"Trial order successful"},
 {"id":"ready","title":"Go-live readiness confirmed"}
]'::jsonb) ON CONFLICT(id) DO NOTHING;
CREATE TABLE IF NOT EXISTS customer_onboarding (
 lead_id UUID PRIMARY KEY REFERENCES leads(id) ON DELETE CASCADE,
 template_version INTEGER NOT NULL,
 version INTEGER NOT NULL DEFAULT 1,
 steps JSONB NOT NULL CHECK (jsonb_typeof(steps)='array'),
 created_by UUID REFERENCES users(id) ON DELETE SET NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
