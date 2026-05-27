-- Agency-level white-label settings (one global row for single-agency deploys)
CREATE TABLE IF NOT EXISTS agency_settings (
  id          INTEGER PRIMARY KEY DEFAULT 1,
  agency_name TEXT        NOT NULL DEFAULT '10X Performance',
  accent_hex  TEXT        NOT NULL DEFAULT '#e53935',
  logo_url    TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT single_row CHECK (id = 1)
);

-- Seed the default row so GET always returns data
INSERT INTO agency_settings (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;
