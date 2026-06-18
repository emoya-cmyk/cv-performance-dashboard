-- ============================================================
-- 037 — Operator remediation-request queue (Postgres)
-- ------------------------------------------------------------
-- The SECOND, OUTBOUND half of the cli_framework ↔ dashboard bridge. 036 brought
-- cli_framework's per-tenant integration-health snapshot INTO this dashboard
-- (a push the agency READS). This table is the reverse channel: an agency
-- operator REQUESTS a safe cli operation on a tenant from the Integration-Health
-- tile, the request lands here as a row, and cli_framework PULLS it, executes it,
-- and reports the result back. The dashboard NEVER calls cli_framework and NEVER
-- executes anything — it only RECORDS the request; cli decides execution.
--
-- CAUSE/EFFECT INVARIANT — SAFE BY CONSTRUCTION:
--   • Requests are operator-initiated (agency auth on create) and limited to a
--     FIXED ALLOW-LIST of SAFE, idempotent operations:
--       reaudit · clear_breaker · rebuild_index · export_queue
--     There is NO vendor-write action in the enum (no create/update/delete of a
--     vendor record). The action column is CHECK-constrained to the allow-list so
--     even a direct DB insert cannot smuggle an out-of-list action in.
--   • status walks pending → claimed → done|failed. 'claimed' is set atomically
--     when cli pulls (so two pulls can't double-claim the same row); done|failed
--     is the terminal report from cli.
--
--   client_id     — the cli tenant id the action targets. FREE-TEXT, deliberately
--                   NOT FK'd to clients(id) (same rationale as integration_health:
--                   cli tenants need not all exist as dashboard clients). Indexed.
--   action        — the requested operation, CHECK-constrained to the allow-list.
--   params        — JSONB action params (e.g. {"vendor":"acculynx"} for
--                   clear_breaker). Defaults to {}.
--   status        — pending|claimed|done|failed, CHECK-constrained. Default pending.
--   result        — JSONB cli result/error payload (NULL until cli reports).
--   claim_token   — set when a pull claims the row; lets the claimer re-read the
--                   exact rows it just took without relying on UPDATE…RETURNING.
--   requested_by  — the agency user id/email that created the request (audit).
--   created_at    — when the operator requested it.
--   updated_at    — last write (claim or report bumps it).
--   completed_at  — when cli reported a terminal status (NULL until then).
--
-- Idempotent: CREATE … IF NOT EXISTS, safe to re-run on every boot.
-- ============================================================

CREATE TABLE IF NOT EXISTS remediation_requests (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     TEXT        NOT NULL,
  action        TEXT        NOT NULL CHECK (action IN ('reaudit','clear_breaker','rebuild_index','export_queue')),
  params        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  status        TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','claimed','done','failed')),
  result        JSONB,
  claim_token   TEXT,
  requested_by  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS remediation_requests_client_id
  ON remediation_requests (client_id);

-- The pull path scans pending rows oldest-first; the tile lists newest-first.
CREATE INDEX IF NOT EXISTS remediation_requests_status_created
  ON remediation_requests (status, created_at);
