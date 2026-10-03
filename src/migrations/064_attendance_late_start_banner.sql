ALTER TABLE attendance_company_schedule
ADD COLUMN IF NOT EXISTS show_late_start_banner boolean NOT NULL DEFAULT true;
