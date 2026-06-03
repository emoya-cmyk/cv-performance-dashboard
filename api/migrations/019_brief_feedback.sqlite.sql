-- ============================================================
-- 019 (SQLite) — brief_feedback sibling.
-- ------------------------------------------------------------
-- Mirrors 019_brief_feedback.sql with SQLite-native types:
--   UUID        → TEXT          TIMESTAMPTZ → TEXT (CURRENT_TIMESTAMP)
--   DATE        → TEXT
-- The composite PRIMARY KEY (client_id, as_of) is the same ON CONFLICT arbiter the
-- vote upsert in lib/briefEngagementEngine.js targets on both backends, so ONE upsert
-- shape (… ON CONFLICT (client_id, as_of) DO UPDATE SET signal = EXCLUDED.signal …)
-- runs against either database. signal stays a plain TEXT column ('helpful' |
-- 'not_helpful'); the write route validates it and lib/briefEngagement.js buckets any
-- other value as an ignored non-vote, so no CHECK is needed for correctness.
--
-- Same privacy invariant as the Postgres twin: the aggregate over this table is
-- agency-only; a client reads back only their own { as_of, signal } row.
-- ============================================================

CREATE TABLE IF NOT EXISTS brief_feedback (
  client_id   TEXT    NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  as_of       TEXT    NOT NULL,
  signal      TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (client_id, as_of)
);

CREATE INDEX IF NOT EXISTS ix_brief_feedback_as_of
  ON brief_feedback (as_of);
