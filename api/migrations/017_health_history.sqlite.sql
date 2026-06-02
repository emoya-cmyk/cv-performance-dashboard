-- ============================================================
-- 017 (SQLite) — per-sweep health-score history sibling.
-- ------------------------------------------------------------
-- Mirrors 017_health_history.sql with SQLite-native types. This sibling is
-- MANDATORY: the SQLite migration runner skips any plain-.sql statement matching
-- a PG-only pattern (UUID / TIMESTAMPTZ / …), so the plain CREATE TABLE — which
-- names BOTH — would be dropped entirely and the table would never exist under the
-- shim. The runner prefers this *.sqlite.sql file by NNN_ prefix and runs the whole
-- file via conn.exec() (multi-statement), swallowing "already exists".
--   BIGSERIAL PRIMARY KEY → INTEGER PRIMARY KEY AUTOINCREMENT
--   UUID                  → TEXT (clients.id is a TEXT uuid under the shim)
--   TIMESTAMPTZ           → TEXT (ISO-8601 string)
-- No FK clause is declared — the shim doesn't enforce ON DELETE CASCADE, the engine
-- never orphans rows, and a stale history row simply never gets read.
-- ============================================================

CREATE TABLE IF NOT EXISTS health_score_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id  TEXT    NOT NULL,
  scored_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  score      INTEGER NOT NULL,
  band       TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS health_score_history_client_time
  ON health_score_history (client_id, scored_at);
