-- Isolated per-employee Follow-up Log preference; no changes to attendance data.
CREATE TABLE IF NOT EXISTS public.employee_follow_up_settings (
  user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  require_customer_feedback boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.employee_follow_up_settings ENABLE ROW LEVEL SECURITY;
-- Only authenticated Express backend's database connection may access this table.
REVOKE ALL ON TABLE public.employee_follow_up_settings FROM anon, authenticated;
