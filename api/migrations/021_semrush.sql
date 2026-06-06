-- 021: SEMrush organic search integration
-- Adds website_domain to clients and creates the semrush_snapshots ledger.

ALTER TABLE clients ADD COLUMN IF NOT EXISTS website_domain TEXT;

CREATE TABLE IF NOT EXISTS semrush_snapshots (
  id                SERIAL PRIMARY KEY,
  client_id         TEXT        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  domain            TEXT        NOT NULL,
  snapshot_date     DATE        NOT NULL DEFAULT CURRENT_DATE,
  organic_keywords  INTEGER     NOT NULL DEFAULT 0,
  organic_traffic   INTEGER     NOT NULL DEFAULT 0,
  traffic_value     NUMERIC(12,2) NOT NULL DEFAULT 0,
  domain_rank       INTEGER     NOT NULL DEFAULT 0,
  top_keywords      JSONB       NOT NULL DEFAULT '[]',
  competitors       JSONB       NOT NULL DEFAULT '[]',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(client_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_semrush_client_date
  ON semrush_snapshots(client_id, snapshot_date DESC);
