-- ============================================================
-- 012 (SQLite) — ai_recaps sibling.
-- ------------------------------------------------------------
-- Mirrors 012_ai_recaps.sql with SQLite-native types:
--   UUID        → TEXT          JSONB       → TEXT (JSON string)
--   DATE        → TEXT          TIMESTAMPTZ → TEXT (CURRENT_TIMESTAMP)
--   BOOLEAN     → INTEGER (0/1)
-- The composite PRIMARY KEY (client_id, week_start) is the same ON CONFLICT
-- arbiter the recap upsert targets on both backends, so api/lib/recap.js runs
-- one upsert shape against either database.
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_recaps (
  client_id     TEXT    NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  week_start    TEXT    NOT NULL,
  model         TEXT,
  evidence_pack TEXT    NOT NULL DEFAULT '{}',
  recap_text    TEXT,
  grounded      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (client_id, week_start)
);

CREATE INDEX IF NOT EXISTS ix_ai_recaps_week
  ON ai_recaps (week_start);
