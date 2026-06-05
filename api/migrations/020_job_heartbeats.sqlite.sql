-- ============================================================
-- 020 (SQLite) — autonomy-loop heartbeat ledger sibling.
-- ------------------------------------------------------------
-- Mirrors 020_job_heartbeats.sql with SQLite-native types. This sibling is
-- MANDATORY for the same reason as 017's: the SQLite runner skips any plain-.sql
-- statement matching a PG-only pattern (BIGSERIAL / TIMESTAMPTZ / …), so the plain
-- CREATE TABLE would be dropped and the table would never exist under the shim. The
-- runner prefers this *.sqlite.sql file by NNN_ prefix and runs the whole file via
-- conn.exec(), swallowing "already exists".
--   BIGSERIAL PRIMARY KEY → INTEGER PRIMARY KEY AUTOINCREMENT
--   TIMESTAMPTZ           → TEXT (ISO-8601 string)
--   detail TEXT           → identical (JSON stored as a string in both dialects)
-- The (job, ran_at DESC) index serves the "latest run per job" read directly.
-- ============================================================

CREATE TABLE IF NOT EXISTS job_heartbeats (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job         TEXT    NOT NULL,
  status      TEXT    NOT NULL,
  ran_at      TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  duration_ms INTEGER,
  detail      TEXT
);

CREATE INDEX IF NOT EXISTS job_heartbeats_job_time
  ON job_heartbeats (job, ran_at DESC);
