-- saved dashboards (Phase 3) — SQLite sibling of 034_dashboards.sql.
-- JSONB → TEXT (we store JSON.stringify'd widget arrays and parse on read).
CREATE TABLE IF NOT EXISTS dashboards (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id    TEXT,                                   -- NULL = agency-owned
  name         TEXT    NOT NULL,
  widgets      TEXT    NOT NULL DEFAULT '[]',
  created_by   TEXT,                                   -- user id that created it (audit)
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_dashboards_scope ON dashboards (client_id, created_at);
