-- 021: SEMrush organic search integration (SQLite)
ALTER TABLE clients ADD COLUMN website_domain TEXT;

CREATE TABLE IF NOT EXISTS semrush_snapshots (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id         TEXT    NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  domain            TEXT    NOT NULL,
  snapshot_date     TEXT    NOT NULL DEFAULT (DATE('now')),
  organic_keywords  INTEGER NOT NULL DEFAULT 0,
  organic_traffic   INTEGER NOT NULL DEFAULT 0,
  traffic_value     REAL    NOT NULL DEFAULT 0,
  domain_rank       INTEGER NOT NULL DEFAULT 0,
  top_keywords      TEXT    NOT NULL DEFAULT '[]',
  competitors       TEXT    NOT NULL DEFAULT '[]',
  created_at        TEXT    NOT NULL DEFAULT (DATETIME('now')),
  UNIQUE(client_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_semrush_client_date
  ON semrush_snapshots(client_id, snapshot_date DESC);
