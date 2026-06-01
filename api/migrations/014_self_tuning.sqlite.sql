-- ============================================================
-- 014 (SQLite) — forecast_grades + metric_calibration sibling.
-- ------------------------------------------------------------
-- Mirrors 014_self_tuning.sql with SQLite-native types:
--   UUID        → TEXT          NUMERIC     → REAL
--   BIGSERIAL   → INTEGER PRIMARY KEY AUTOINCREMENT
--   BOOLEAN     → INTEGER (0/1) TIMESTAMPTZ → TEXT (CURRENT_TIMESTAMP)
--   DATE/month  → TEXT 'YYYY-MM-01' (lexicographically comparable, so `month < $cur` works)
-- The same UNIQUE(client_id, metric, month) insert-once arbiter and the
-- ON CONFLICT(client_id, metric, grain) calibration upsert in lib/insights.js
-- run unchanged against either backend.
-- ============================================================

CREATE TABLE IF NOT EXISTS forecast_grades (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id           TEXT    NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  metric              TEXT    NOT NULL,
  month               TEXT    NOT NULL,
  as_of               TEXT,
  projected_total     REAL,
  naive_projected     REAL,
  target              REAL,
  actual_total        REAL,
  abs_pct_error       REAL,
  naive_abs_pct_error REAL,
  bias                REAL,
  model_won           INTEGER,
  graded_at           TEXT,
  created_at          TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (client_id, metric, month)
);

CREATE INDEX IF NOT EXISTS ix_fcgrades_due        ON forecast_grades (client_id, month);
CREATE INDEX IF NOT EXISTS ix_fcgrades_scoreboard ON forecast_grades (client_id, metric);

CREATE TABLE IF NOT EXISTS metric_calibration (
  client_id   TEXT    NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  metric      TEXT    NOT NULL,
  grain       TEXT    NOT NULL DEFAULT 'month',
  warn_ratio  REAL,
  crit_ratio  REAL,
  bias_factor REAL    NOT NULL DEFAULT 1,
  trust       REAL,
  mape        REAL,
  samples     INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (client_id, metric, grain)
);
