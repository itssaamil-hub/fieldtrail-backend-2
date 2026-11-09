-- One canonical photo reference per lead: use existing leads.photo_url.
-- Salesman-specific requirement defaults OFF; no impact on attendance or GPS.
ALTER TABLE public.salesman_profiles
  ADD COLUMN IF NOT EXISTS require_lead_photo boolean NOT NULL DEFAULT false;

-- Private image bucket; images are never exposed through public object URLs.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('engage-lead-photos','engage-lead-photos', false, 153600, ARRAY['image/webp']::text[])
ON CONFLICT (id) DO UPDATE
  SET public = false, file_size_limit = 153600,
      allowed_mime_types = ARRAY['image/webp']::text[];

-- Durable storage deletion retry queue, NOT a second photo record.
CREATE TABLE IF NOT EXISTS public.lead_photo_cleanup_queue (
  path text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  last_error text
);
ALTER TABLE public.lead_photo_cleanup_queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.lead_photo_cleanup_queue FROM anon, authenticated;
