-- Add contact_email + calendar_url to agency settings (agency-wide defaults)
ALTER TABLE agency_settings ADD COLUMN IF NOT EXISTS contact_email TEXT;
ALTER TABLE agency_settings ADD COLUMN IF NOT EXISTS calendar_url  TEXT;

-- Add per-client overrides (fall back to agency settings when null)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS contact_email TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS calendar_url  TEXT;
