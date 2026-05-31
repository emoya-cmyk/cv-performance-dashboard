-- ============================================================
-- 013 (SQLite) — metric_baselines + insights sibling.
-- ------------------------------------------------------------
-- Mirrors 013_intelligence.sql with SQLite-native types:
--   UUID        → TEXT          JSONB       → TEXT (JSON string)
--   NUMERIC     → REAL          TIMESTAMPTZ → TEXT (CURRENT_TIMESTAMP)
--   BIGSERIAL   → INTEGER PRIMARY KEY AUTOINCREMENT
--   BOOLEAN     → INTEGER (0/1)
-- `fingerprint` keeps its UNIQUE constraint so the same idempotent
-- ON CONFLICT(fingerprint) upsert in lib/insights.js runs against either backend.
-- ============================================================

CREATE TABLE IF NOT EXISTS metric_baselines (
  client_id   TEXT    NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  metric      TEXT    NOT NULL,
  grain       TEXT    NOT NULL DEFAULT 'week',
  n           INTEGER NOT NULL DEFAULT 0,
  mean        REAL,
  std         REAL,
  median      REAL,
  mad         REAL,
  robust_std  REAL,
  slope       REAL,
  ewma        REAL,
  latest      REAL,
  updated_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (client_id, metric, grain)
);

CREATE TABLE IF NOT EXISTS insights (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id    TEXT    REFERENCES clients(id) ON DELETE CASCADE,
  scope        TEXT    NOT NULL DEFAULT 'client',
  kind         TEXT    NOT NULL,
  metric       TEXT,
  severity     TEXT    NOT NULL DEFAULT 'info',
  direction    TEXT,
  score        REAL    NOT NULL DEFAULT 0,
  title        TEXT    NOT NULL,
  detail       TEXT,
  evidence     TEXT    NOT NULL DEFAULT '{}',
  fingerprint  TEXT    NOT NULL UNIQUE,
  period_start TEXT,
  status       TEXT    NOT NULL DEFAULT 'open',
  model        TEXT,
  grounded     INTEGER NOT NULL DEFAULT 0,
  first_seen   TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen    TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS ix_insights_client ON insights (client_id, status);
CREATE INDEX IF NOT EXISTS ix_insights_open   ON insights (status, severity, score);
CREATE INDEX IF NOT EXISTS ix_insights_period ON insights (period_start);
