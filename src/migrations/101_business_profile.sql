CREATE TABLE IF NOT EXISTS business_profile (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  business_name VARCHAR(160) NOT NULL DEFAULT '',
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO business_profile (id, business_name)
VALUES (1, '')
ON CONFLICT (id) DO NOTHING;
