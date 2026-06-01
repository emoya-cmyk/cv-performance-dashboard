-- ============================================================
-- 015 (SQLite) — insight_precision sibling.
-- ------------------------------------------------------------
-- Mirrors 015_insight_precision.sql with SQLite-native types:
--   UUID        → TEXT          NUMERIC     → REAL
--   TIMESTAMPTZ → TEXT (CURRENT_TIMESTAMP)
-- The same PRIMARY KEY(client_id, signature) arbiter and the
-- ON CONFLICT(client_id, signature) precision upsert in lib/insights.js
-- run unchanged against either backend.
-- ============================================================

CREATE TABLE IF NOT EXISTS insight_precision (
  client_id   TEXT    NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  signature   TEXT    NOT NULL,
  kind        TEXT    NOT NULL,
  metric      TEXT,
  engaged     INTEGER NOT NULL DEFAULT 0,
  ignored     INTEGER NOT NULL DEFAULT 0,
  n           INTEGER NOT NULL DEFAULT 0,
  confidence  REAL,
  band        TEXT,
  weight      REAL    NOT NULL DEFAULT 1,
  updated_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (client_id, signature)
);
