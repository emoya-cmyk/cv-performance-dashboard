-- SQLite mirror of 031_make_remediation.sql (local dev). The route always
-- supplies `id` (crypto.randomUUID), so these PKs need no default generator.

CREATE TABLE IF NOT EXISTS make_remediation_log (
  id                      TEXT    PRIMARY KEY,
  created_at              TEXT    NOT NULL DEFAULT (datetime('now')),
  scenario_id             TEXT    NOT NULL,
  scenario_name           TEXT,
  execution_id            TEXT    UNIQUE,
  tenant_id               TEXT    NOT NULL,
  vendor                  TEXT    NOT NULL,
  failure_tier            INTEGER NOT NULL CHECK (failure_tier IN (0,1,2,3)),
  error_code              INTEGER,
  error_message           TEXT,
  error_type              TEXT,
  module_name             TEXT,
  remediation_action      TEXT,
  remediation_outcome     TEXT CHECK (remediation_outcome IN ('success','failed','pending','escalated')),
  auto_resolved           INTEGER DEFAULT 0,
  human_required          INTEGER DEFAULT 0,
  retry_count             INTEGER DEFAULT 0,
  dead_lettered           INTEGER DEFAULT 0,
  circuit_breaker_tripped INTEGER DEFAULT 0,
  llm_enrichment          TEXT,
  raw_payload_hash        TEXT,
  wilson_score_delta      REAL,
  resolved_at             TEXT,
  resolved_by             TEXT
);
CREATE INDEX IF NOT EXISTS idx_make_remed_tenant ON make_remediation_log (tenant_id, vendor, created_at);
CREATE INDEX IF NOT EXISTS idx_make_remed_tier   ON make_remediation_log (failure_tier, created_at);

CREATE TABLE IF NOT EXISTS make_dead_letter (
  id               TEXT PRIMARY KEY,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  execution_id     TEXT,
  scenario_id      TEXT,
  scenario_name    TEXT,
  tenant_id        TEXT NOT NULL,
  vendor           TEXT NOT NULL,
  failure_tier     INTEGER,
  original_error   TEXT,
  suggested_action TEXT,
  raw_payload_hash TEXT,
  field_gap        TEXT,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolved_at      TEXT,
  resolved_by      TEXT
);
CREATE INDEX IF NOT EXISTS idx_make_dl_status ON make_dead_letter (status, created_at);

CREATE TABLE IF NOT EXISTS make_circuit_breaker (
  tenant_id            TEXT    NOT NULL,
  vendor               TEXT    NOT NULL,
  tripped              INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  reason               TEXT,
  tripped_at           TEXT,
  cleared_at           TEXT,
  cleared_by           TEXT,
  updated_at           TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, vendor)
);
