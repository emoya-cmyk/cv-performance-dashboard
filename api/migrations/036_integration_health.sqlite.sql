-- ============================================================
-- 022 (SQLite) — integration-health snapshot ingest sibling.
-- ------------------------------------------------------------
-- Mirrors 022_integration_health.sql with SQLite-native types. This sibling is
-- MANDATORY: the SQLite runner skips any plain-.sql statement matching a PG-only
-- pattern (UUID / gen_random_uuid / TIMESTAMPTZ / …), so the plain CREATE TABLE
-- would be dropped and the table would never exist under the shim. The runner
-- prefers this *.sqlite.sql file by NNN_ prefix and runs the whole file via
-- conn.exec(), swallowing "already exists".
--   UUID PRIMARY KEY DEFAULT gen_random_uuid() → TEXT PRIMARY KEY (the app supplies
--     a crypto.randomUUID() id on INSERT, mirroring the other UUID-PK tables).
--   TIMESTAMPTZ            → TEXT (ISO-8601 string)
--   JSONB                 → TEXT (the breakers_tripped array is JSON.stringify'd on
--                           write and JSON.parse'd by the reader, both dialects).
--   CHECK / UNIQUE / index → identical.
-- ============================================================

CREATE TABLE IF NOT EXISTS integration_health (
  id                TEXT    PRIMARY KEY,
  client_id         TEXT    NOT NULL,
  health            TEXT    NOT NULL CHECK (health IN ('ok','watch','degraded','critical')),
  audit_critical    INTEGER NOT NULL DEFAULT 0,
  audit_high        INTEGER NOT NULL DEFAULT 0,
  audit_medium      INTEGER NOT NULL DEFAULT 0,
  audit_low         INTEGER NOT NULL DEFAULT 0,
  audit_as_of       TEXT,
  dead_letters_open INTEGER NOT NULL DEFAULT 0,
  breakers_tripped  TEXT    NOT NULL DEFAULT '[]',
  last_activity     TEXT,
  reported_at       TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (client_id)
);

CREATE INDEX IF NOT EXISTS integration_health_client_id
  ON integration_health (client_id);
