-- Write-Verification Correctness Primitive (Spec A — cli_framework).
--
-- The remediation log proves a write PERSISTED. It does not prove the written
-- value matches intent. A persisted write is only *correlated* with a correct
-- one. This ledger records the round-trip read-back result so the (future)
-- Wilson promotion gate can run on VERIFIED_CORRECT / total per (tenant,
-- endpoint) instead of on persistence — which would otherwise bake the
-- persistence-vs-correctness conflation into the autonomy layer permanently.
--
--   write_verification_log   — append-only, one row per verified write
--   write_verification_stats — per (tenant_id, endpoint) correctness accumulator
--                              (the input the promotion gate will read; NOT yet
--                              wired — build correctness samples first).

CREATE TABLE IF NOT EXISTS write_verification_log (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  tenant_id           TEXT NOT NULL,
  endpoint            TEXT NOT NULL,
  vendor              TEXT,
  scenario_id         TEXT,
  execution_id        TEXT,
  canonical_id        TEXT,
  canonical_id_kind   TEXT CHECK (canonical_id_kind IN ('primary','email_fallback','phone_fallback')),
  outcome             TEXT NOT NULL CHECK (outcome IN ('FAILED','PERSISTED_UNVERIFIED','PERSISTED_INCORRECT','VERIFIED_CORRECT')),
  read_back_available BOOLEAN NOT NULL DEFAULT false,
  intended_hash       TEXT,
  field_count         INTEGER NOT NULL DEFAULT 0,
  match_count         INTEGER NOT NULL DEFAULT 0,
  mismatch_fields     TEXT,
  note                TEXT
);
CREATE INDEX IF NOT EXISTS idx_wv_log_scope   ON write_verification_log (tenant_id, endpoint, created_at);
CREATE INDEX IF NOT EXISTS idx_wv_log_outcome ON write_verification_log (outcome);

CREATE TABLE IF NOT EXISTS write_verification_stats (
  tenant_id            TEXT NOT NULL,
  endpoint             TEXT NOT NULL,
  failed               INTEGER NOT NULL DEFAULT 0,
  persisted_unverified INTEGER NOT NULL DEFAULT 0,
  persisted_incorrect  INTEGER NOT NULL DEFAULT 0,
  verified_correct     INTEGER NOT NULL DEFAULT 0,
  total                INTEGER NOT NULL DEFAULT 0,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, endpoint)
);
