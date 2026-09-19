-- Trusted lead capture may create a lead without Start Day / GPS.
-- These two fields were still NOT NULL from 001_init.sql, which caused a
-- PostgreSQL 500 when the API intentionally inserted NULL for a GPS-less lead.
ALTER TABLE leads ALTER COLUMN captured_at DROP NOT NULL;
ALTER TABLE leads ALTER COLUMN verification_status DROP NOT NULL;
