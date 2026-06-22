-- ============================================================
-- 037 (SQLite) — operator remediation-request queue sibling.
-- ------------------------------------------------------------
-- Mirrors 037_remediation_requests.sql with SQLite-native types. MANDATORY: the
-- SQLite runner drops any plain-.sql statement matching a PG-only pattern
-- (UUID / gen_random_uuid / TIMESTAMPTZ / …), so the plain CREATE TABLE would be
-- skipped and the table would never exist under the shim. The runner prefers this
-- *.sqlite.sql file by NNN_ prefix and runs the whole file via conn.exec(),
-- swallowing "already exists".
--   UUID PRIMARY KEY DEFAULT gen_random_uuid() → TEXT PRIMARY KEY (the app supplies
--     a crypto.randomUUID() id on INSERT, mirroring the other UUID-PK tables).
--   TIMESTAMPTZ           → TEXT (ISO-8601 string)
--   JSONB                → TEXT (params/result are JSON.stringify'd on write and
--                          JSON.parse'd by the reader, both dialects).
--   CHECK / index        → identical (the allow-list + status enum are enforced here too).
-- ============================================================

CREATE TABLE IF NOT EXISTS remediation_requests (
  id            TEXT    PRIMARY KEY,
  client_id     TEXT    NOT NULL,
  action        TEXT    NOT NULL CHECK (action IN ('reaudit','clear_breaker','rebuild_index','export_queue')),
  params        TEXT    NOT NULL DEFAULT '{}',
  status        TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','claimed','done','failed')),
  result        TEXT,
  claim_token   TEXT,
  requested_by  TEXT,
  created_at    TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at  TEXT
);

CREATE INDEX IF NOT EXISTS remediation_requests_client_id
  ON remediation_requests (client_id);

CREATE INDEX IF NOT EXISTS remediation_requests_status_created
  ON remediation_requests (status, created_at);
