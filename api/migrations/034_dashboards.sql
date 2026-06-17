-- ── saved dashboards (Phase 3 — composable / saved dashboards) ──────────────
-- A dashboard is a named collection of widgets. Each widget is a saved semantic
-- query spec ({metrics,dimensions/groupBy,grain,filters,...}) plus a viz type +
-- title + layout, serialized into the JSONB `widgets` column. Specs are never
-- trusted at render time: every widget query is re-run through the SAME
-- POST /api/query path (semantic/compile.runQuerySpec) with the SAME tenant
-- clamp, so a saved spec can never read another tenant's facts.
--
-- Scope: client_id NULL = an agency-owned dashboard (every agency user sees it);
-- client_id set = a client-scoped dashboard (its owning client + agency see it).
CREATE TABLE IF NOT EXISTS dashboards (
  id           SERIAL       PRIMARY KEY,
  client_id    TEXT,                                   -- NULL = agency-owned
  name         TEXT         NOT NULL,
  widgets      JSONB        NOT NULL DEFAULT '[]'::jsonb,
  created_by   TEXT,                                   -- user id that created it (audit)
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_dashboards_scope ON dashboards (client_id, created_at);
