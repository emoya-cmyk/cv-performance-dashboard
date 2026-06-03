-- ============================================================
-- 018 (SQLite) — ai_briefs sibling.
-- ------------------------------------------------------------
-- Mirrors 018_ai_briefs.sql with SQLite-native types:
--   UUID        → TEXT          JSONB       → TEXT (JSON string)
--   DATE        → TEXT          TIMESTAMPTZ → TEXT (CURRENT_TIMESTAMP)
--   BOOLEAN     → INTEGER (0/1)
-- The composite PRIMARY KEY (scope_key, as_of) is the same ON CONFLICT arbiter
-- the brief upsert targets on both backends, so api/lib/brief.js runs one
-- upsert shape against either database. client_id stays a nullable reference
-- column (NULL for the '__portfolio__' brief) and is never part of the key.
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_briefs (
  scope_key   TEXT    NOT NULL,
  as_of       TEXT    NOT NULL,
  audience    TEXT    NOT NULL DEFAULT 'client',
  client_id   TEXT    REFERENCES clients(id) ON DELETE CASCADE,
  model       TEXT,
  pack        TEXT    NOT NULL DEFAULT '{}',
  brief_text  TEXT,
  grounded    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (scope_key, as_of)
);

CREATE INDEX IF NOT EXISTS ix_ai_briefs_as_of
  ON ai_briefs (as_of);
