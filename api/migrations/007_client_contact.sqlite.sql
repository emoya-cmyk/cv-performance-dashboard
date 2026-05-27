-- SQLite-specific: no IF NOT EXISTS on ALTER TABLE ADD COLUMN
-- Migration runner catches "duplicate column" and swallows it safely
ALTER TABLE agency_settings ADD COLUMN contact_email TEXT;
ALTER TABLE agency_settings ADD COLUMN calendar_url  TEXT;
ALTER TABLE clients ADD COLUMN contact_email TEXT;
ALTER TABLE clients ADD COLUMN calendar_url  TEXT;
