-- Shareable report links (token-based, no login required)
CREATE TABLE IF NOT EXISTS report_shares (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  token        TEXT        UNIQUE NOT NULL
                           DEFAULT encode(gen_random_bytes(18), 'base64'),
  client_id    UUID        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  created_by   UUID        REFERENCES users(id) ON DELETE SET NULL,
  expires_at   TIMESTAMPTZ,          -- NULL = never expires
  revoked_at   TIMESTAMPTZ,          -- NULL = still active
  access_count INTEGER     NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS report_shares_token_idx     ON report_shares (token);
CREATE INDEX IF NOT EXISTS report_shares_client_idx    ON report_shares (client_id);
