-- Make.com Autonomous Remediation System — Layer B (PRD FR-7, FR-4, FR-5).
-- Three tables: the append-only event log, the operator dead-letter queue, and
-- the per-tenant/vendor circuit-breaker state.

-- ── FR-7: append-only remediation log ───────────────────────────────────────
-- One row per failure event. Log-first (Session Rule 5): the row is written
-- with outcome 'pending' before any remediation action runs, then updated.
CREATE TABLE IF NOT EXISTS make_remediation_log (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at              TIMESTAMPTZ DEFAULT now(),
  scenario_id             TEXT NOT NULL,
  scenario_name           TEXT,
  execution_id            TEXT UNIQUE,
  tenant_id               TEXT NOT NULL,
  vendor                  TEXT NOT NULL,
  failure_tier            INTEGER NOT NULL CHECK (failure_tier IN (0,1,2,3)),
  error_code              INTEGER,
  error_message           TEXT,
  error_type              TEXT,
  module_name             TEXT,
  remediation_action      TEXT,
  remediation_outcome     TEXT CHECK (remediation_outcome IN ('success','failed','pending','escalated')),
  auto_resolved           BOOLEAN DEFAULT false,
  human_required          BOOLEAN DEFAULT false,
  retry_count             INTEGER DEFAULT 0,
  dead_lettered           BOOLEAN DEFAULT false,
  circuit_breaker_tripped BOOLEAN DEFAULT false,
  llm_enrichment          TEXT,
  raw_payload_hash        TEXT,
  wilson_score_delta      DOUBLE PRECISION,
  resolved_at             TIMESTAMPTZ,
  resolved_by             TEXT
);
CREATE INDEX IF NOT EXISTS idx_make_remed_tenant ON make_remediation_log (tenant_id, vendor, created_at);
CREATE INDEX IF NOT EXISTS idx_make_remed_tier   ON make_remediation_log (failure_tier, created_at);

-- ── FR-4: dead-letter queue → operator fix queue ─────────────────────────────
-- Never discarded; always recoverable. 30-day minimum retention (enforced by a
-- cleanup sweep, not a destructive default here).
CREATE TABLE IF NOT EXISTS make_dead_letter (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at       TIMESTAMPTZ DEFAULT now(),
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
  resolved_at      TIMESTAMPTZ,
  resolved_by      TEXT
);
CREATE INDEX IF NOT EXISTS idx_make_dl_status ON make_dead_letter (status, created_at);

-- ── FR-5: circuit-breaker state (one row per tenant+vendor pair) ──────────────
CREATE TABLE IF NOT EXISTS make_circuit_breaker (
  tenant_id            TEXT NOT NULL,
  vendor               TEXT NOT NULL,
  tripped              BOOLEAN NOT NULL DEFAULT false,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  reason               TEXT,
  tripped_at           TIMESTAMPTZ,
  cleared_at           TIMESTAMPTZ,
  cleared_by           TEXT,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, vendor)
);
