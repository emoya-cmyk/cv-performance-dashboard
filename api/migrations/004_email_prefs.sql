-- Weekly email digest preferences (stored directly on clients row)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS digest_email     TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS digest_enabled   BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS unsubscribe_token TEXT
  DEFAULT encode(gen_random_bytes(16), 'hex');

-- Dashboard URL for email links (set per agency, e.g. https://yourdomain.com)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS dashboard_url TEXT;
