-- SQLite mirror of 035_write_verification.sql. ids are generated in JS
-- (crypto.randomUUID, like the rest of the Make remediation writers), so no
-- UUID default is needed here.

CREATE TABLE IF NOT EXISTS write_verification_log (
  id                  TEXT PRIMARY KEY,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  tenant_id           TEXT NOT NULL,
  endpoint            TEXT NOT NULL,
  vendor              TEXT,
  scenario_id         TEXT,
  execution_id        TEXT,
  canonical_id        TEXT,
  canonical_id_kind   TEXT CHECK (canonical_id_kind IN ('primary','email_fallback','phone_fallback')),
  outcome             TEXT NOT NULL CHECK (outcome IN ('FAILED','PERSISTED_UNVERIFIED','PERSISTED_INCORRECT','VERIFIED_CORRECT')),
  read_back_available INTEGER NOT NULL DEFAULT 0,
  intended_hash       TEXT,
  field_count         INTEGER NOT NULL DEFAULT 0,
  match_count         INTEGER NOT NULL DEFAULT 0,
  mismatch_fields     TEXT,
  note                TEXT
);
CREATE INDEX IF NOT EXISTS idx_wv_log_scope   ON write_verification_log (tenant_id, endpoint, created_at);
CREATE INDEX IF NOT EXISTS idx_wv_log_outcome ON write_verification_log (outcome);

CREATE TABLE IF NOT EXISTS write_verification_stats (
  tenant_id            TEXT    NOT NULL,
  endpoint             TEXT    NOT NULL,
  failed               INTEGER NOT NULL DEFAULT 0,
  persisted_unverified INTEGER NOT NULL DEFAULT 0,
  persisted_incorrect  INTEGER NOT NULL DEFAULT 0,
  verified_correct     INTEGER NOT NULL DEFAULT 0,
  total                INTEGER NOT NULL DEFAULT 0,
  updated_at           TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, endpoint)
);
