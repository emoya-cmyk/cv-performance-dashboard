-- ============================================================
-- 036 — Integration-health snapshot ingest (Postgres)
-- ------------------------------------------------------------
-- The cli_framework toolkit (a SEPARATE repo operating the multi-tenant
-- CRM/field-service integrations) now emits a read-only, per-tenant
-- integration-health JSON. This dashboard INGESTS that payload over a
-- machine-to-machine push (POST /api/integration-health, shared-secret gated)
-- and renders it for agency operators on the Intelligence page. The dashboard
-- does NOT call cli_framework — it is a passive sink, INERT until data is pushed.
--
-- This table is the landing zone: ONE row per cli tenant, UPSERTed by client_id
-- so each ingest replaces that tenant's latest snapshot (no history kept — the
-- producer is the source of truth, this is a mirror of "current health").
--
--   client_id          — the cli tenant id. FREE-TEXT, deliberately NOT FK'd to
--                         clients(id): cli tenants need not all exist as dashboard
--                         clients, so a FK would reject valid snapshots. Just stored
--                         + indexed + UNIQUE (the upsert key).
--   health             — overall grade, CHECK-constrained to the producer's enum.
--   audit_*            — the audit finding counts by severity (NULL audit → all 0
--                         with a NULL audit_as_of, since a tenant may be unaudited).
--   dead_letters_open  — open dead-letter count (resilience backlog).
--   breakers_tripped   — JSONB array of {vendor,reason,since} tripped-breaker objects.
--   last_activity      — last integration activity seen for the tenant (nullable).
--   reported_at        — the payload's generated_at (when the producer snapshotted).
--   updated_at         — when THIS row was last written (ingest clock).
--
-- Idempotent: CREATE … IF NOT EXISTS, safe to re-run on every boot.
-- (up-ported from agency-performance-dashboard 022 as part of hub convergence; renumbered to 036 in cv.)
-- ============================================================

CREATE TABLE IF NOT EXISTS integration_health (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         TEXT        NOT NULL,
  health            TEXT        NOT NULL CHECK (health IN ('ok','watch','degraded','critical')),
  audit_critical    INTEGER     NOT NULL DEFAULT 0,
  audit_high        INTEGER     NOT NULL DEFAULT 0,
  audit_medium      INTEGER     NOT NULL DEFAULT 0,
  audit_low         INTEGER     NOT NULL DEFAULT 0,
  audit_as_of       TIMESTAMPTZ,
  dead_letters_open INTEGER     NOT NULL DEFAULT 0,
  breakers_tripped  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  last_activity     TIMESTAMPTZ,
  reported_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (client_id)
);

CREATE INDEX IF NOT EXISTS integration_health_client_id
  ON integration_health (client_id);
