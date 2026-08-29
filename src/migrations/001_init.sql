-- FieldTrail: Salesman Lead Tracking & Live Location
-- Initial schema. Run with `npm run migrate`.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS postgis;

-- ---------------------------------------------------------------------------
CREATE TYPE user_role AS ENUM ('admin', 'salesman');
CREATE TYPE salesman_status AS ENUM ('offline', 'online', 'on_visit');
CREATE TYPE lead_status AS ENUM (
  'new','contacted','follow_up','demo_scheduled',
  'proposal_sent','negotiation','won','lost'
);
CREATE TYPE verification_status AS ENUM ('verified','poor_accuracy','unverified');
CREATE TYPE notification_type AS ENUM (
  'new_lead','out_of_radius','inactive_salesman','gps_disabled',
  'location_permission_off','poor_accuracy','day_started','day_ended',
  'lead_converted','mock_gps_suspected','suspicious_jump'
);

-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role user_role NOT NULL,
  full_name TEXT NOT NULL,
  phone TEXT UNIQUE NOT NULL,
  email TEXT,
  password_hash TEXT NOT NULL,
  photo_url TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE salesman_profiles (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  employee_code TEXT,
  device_id TEXT,
  daily_target INT NOT NULL DEFAULT 8,
  status salesman_status NOT NULL DEFAULT 'offline',
  last_seen_at TIMESTAMPTZ,
  last_lat DOUBLE PRECISION,
  last_lng DOUBLE PRECISION,
  last_battery_pct SMALLINT,
  last_speed_mps REAL
);

-- ---------------------------------------------------------------------------
CREATE TABLE location_pings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salesman_id UUID NOT NULL REFERENCES users(id),
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  geom GEOGRAPHY(Point, 4326) GENERATED ALWAYS AS (
    ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography
  ) STORED,
  accuracy_m REAL,
  speed_mps REAL,
  battery_pct SMALLINT,
  is_mock_suspected BOOLEAN NOT NULL DEFAULT false,
  captured_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_location_pings_salesman_time ON location_pings (salesman_id, captured_at DESC);
CREATE INDEX idx_location_pings_geom ON location_pings USING GIST (geom);

-- ---------------------------------------------------------------------------
CREATE TABLE leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_uuid UUID UNIQUE NOT NULL,  -- offline idempotency key, set by the device
  salesman_id UUID NOT NULL REFERENCES users(id),
  business_name TEXT NOT NULL,
  contact_name TEXT,
  phone TEXT,
  whatsapp TEXT,
  address TEXT,
  category TEXT,
  branch_count INT,
  current_pos TEXT,
  estimated_requirement TEXT,
  status lead_status NOT NULL DEFAULT 'new',
  notes TEXT,
  photo_url TEXT,

  -- immutable location block — never updated after insert (enforced below)
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  geom GEOGRAPHY(Point, 4326) GENERATED ALWAYS AS (
    ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography
  ) STORED,
  accuracy_m REAL NOT NULL,
  reverse_geocoded_address TEXT,
  captured_at TIMESTAMPTZ NOT NULL,
  device_id TEXT NOT NULL,
  is_mock_suspected BOOLEAN NOT NULL DEFAULT false,
  verification_status verification_status NOT NULL,

  synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_leads_salesman_created ON leads (salesman_id, created_at DESC);
CREATE INDEX idx_leads_status ON leads (status);
CREATE INDEX idx_leads_geom ON leads USING GIST (geom);

-- Enforce write-once location/verification fields at the DB layer, not just
-- in application code — a second line of defence against tampering.
CREATE OR REPLACE FUNCTION prevent_lead_location_edit() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.latitude IS DISTINCT FROM OLD.latitude
     OR NEW.longitude IS DISTINCT FROM OLD.longitude
     OR NEW.accuracy_m IS DISTINCT FROM OLD.accuracy_m
     OR NEW.captured_at IS DISTINCT FROM OLD.captured_at
     OR NEW.verification_status IS DISTINCT FROM OLD.verification_status
     OR NEW.device_id IS DISTINCT FROM OLD.device_id THEN
    RAISE EXCEPTION 'lead location/verification fields are immutable after creation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_lead_location_immutable
  BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION prevent_lead_location_edit();

CREATE TABLE lead_status_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  changed_by UUID NOT NULL REFERENCES users(id),
  old_status lead_status,
  new_status lead_status NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE lead_assignments (
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  salesman_id UUID NOT NULL REFERENCES users(id),
  assigned_by UUID NOT NULL REFERENCES users(id),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (lead_id, salesman_id)
);

-- ---------------------------------------------------------------------------
CREATE TABLE visits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_uuid UUID UNIQUE NOT NULL,
  salesman_id UUID NOT NULL REFERENCES users(id),
  lead_id UUID REFERENCES leads(id),
  business_name TEXT,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  geom GEOGRAPHY(Point, 4326) GENERATED ALWAYS AS (
    ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography
  ) STORED,
  accuracy_m REAL,
  arrived_at TIMESTAMPTZ NOT NULL,
  left_at TIMESTAMPTZ,
  notes TEXT,
  photo_urls TEXT[],
  lead_created BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_visits_salesman ON visits (salesman_id, arrived_at DESC);

-- ---------------------------------------------------------------------------
CREATE TABLE attendance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salesman_id UUID NOT NULL REFERENCES users(id),
  day DATE NOT NULL,
  start_day_at TIMESTAMPTZ,
  start_lat DOUBLE PRECISION,
  start_lng DOUBLE PRECISION,
  end_day_at TIMESTAMPTZ,
  end_lat DOUBLE PRECISION,
  end_lng DOUBLE PRECISION,
  total_distance_m DOUBLE PRECISION NOT NULL DEFAULT 0,
  UNIQUE (salesman_id, day)
);

-- ---------------------------------------------------------------------------
CREATE TABLE verification_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  radius_m INT NOT NULL DEFAULT 100,
  min_accuracy_m INT NOT NULL DEFAULT 50,
  max_speed_kmh INT NOT NULL DEFAULT 150,
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO verification_settings (radius_m, min_accuracy_m, max_speed_kmh) VALUES (100, 50, 150);

-- ---------------------------------------------------------------------------
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type notification_type NOT NULL,
  salesman_id UUID REFERENCES users(id),
  lead_id UUID REFERENCES leads(id),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_notifications_created ON notifications (created_at DESC);

CREATE TABLE activity_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_activity_logs_entity ON activity_logs (entity_type, entity_id);
