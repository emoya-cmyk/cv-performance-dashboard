# Implementation Status — Transformation Plan & Memory OS vs. Reality

**As of 2026-06-16.** This document reconciles the two design docs
(`TRANSFORMATION_PLAN.md`, `MEMORY_OS_PRD.md`) against what is **actually in the
codebase**. The plan still ends with "Nothing here has been built — this is for
review," which is stale: Phases 0–2 and the entire Memory OS have shipped. This
file is the source of truth for "what's real."

Status key: ✅ Shipped · 🚧 Partial · ❌ Not built

Evidence was gathered by reading migrations, routes, lib engines, the semantic
layer, and `src/pages/`. The API test suite is **129 test files** under
`api/test/` (run with `cd api && node --test`).

---

## TRANSFORMATION_PLAN.md

| Item | Status | Evidence | What's missing |
|------|--------|----------|----------------|
| **§2 `sql` vs `sql_count` fix** | ✅ Shipped | `api/migrations/008_fix_sql_count.sql` + `.sqlite.sql` standardize the column. | — |
| **Phase 0 — atomic grain** | ✅ Shipped | `010_atomic_grain.sql`/`.sqlite.sql` create `dim_channel`, `dim_entity`, `fact_metric`; `011_seed_dim_channel.*` seeds channels. `lib/rollup.js` + `lib/facts.js` ingest; tests `ingest.facts.test.js`, `rollup.golden.test.js`, per-connector `*.facts.test.js`. | — |
| **Phase 1 — semantic layer + query API** | ✅ Shipped | `api/semantic/registry.js` (metric/dimension catalog) + `api/semantic/compile.js` (`runQuerySpec`, allow-list validation, JS pivot, compareTo); `api/routes/query.js` serves `POST /api/query` + `GET /api/query/schema`, mounted in `server.js` behind `requireAuth` with a multi-tenant clamp. | — |
| **Phase 2 — advanced analytics** | ✅ Shipped (re-shaped) | Stats in `lib/baselines.js` (z-score, EWMA, linreg slope, severity bands), `lib/forecast.js`, `lib/attribution.js`, `lib/pacing.js`, consumed by `lib/insights.js` and surfaced via the `/api/insights/*` feed + `GET /api/metrics/:clientId/anomalies`. Migrations `013–020` (intelligence, self-tuning, precision, health history, briefs). Tests: `baselines`, `attribution`, `pacing`, `forecast*`, `insights.*`. | Delivered as an intelligence **feed** + anomalies endpoint rather than the literal `/api/insights/forecast|drivers|pacing` URLs in the plan; the math and grounding are present. |
| **Phase 3 — composable / dynamic UI** | 🚧 Partial | `src/pages/Explore.jsx` (769 lines, routed at `/explore`, lazy-loaded in `App.jsx`) is a real, fully-wired explorer: drives `POST /api/query`, builds controls from `GET /api/query/schema`, KPI total cards, recharts viz, results table, channel filters, period compare, CSV export, URL-state round-trip. `src/components/WidgetGrid.jsx` exists. | **No `dashboards` / `dashboard_widgets` table** (no `012_dashboards.sql`), **no `routes/dashboards.js`**, **no `QueryWidget` / `QueryBuilder` / `DateRangePicker` components**, **no user-saved custom dashboards**, and **no click-to-drill-down / breadcrumb** (0 occurrences in `Explore.jsx`). Ad-hoc exploration works; persisted, user-built dashboards and drill-down do not. |
| **Phase 4 — intelligence layer (alerts + grounded narratives)** | 🚧 Partial | Alert rules table `029_client_alert_rules.*` + `027_fired_alerts.*`; `lib/alertDelivery.js` writes `fired_alerts`; `routes/alerts.js` exposes rules/feed; `026_campaign_events`, `028_goal_history` support it. Recommendations/reallocation engines shipped (`lib/reallocationEfficacy*.js`, `/api/insights/reallocation*`). | Alert **rules** + delivery exist, but cron-side rule evaluation is not wired in `routes/cron.js`. **Grounded narratives still template-based**: `verdictFor` (`ClientView.jsx`) and `buildStrategicHeadline` (`ExecView.jsx`) compute from row metrics, not piped `/api/insights/drivers` causal output. |

---

## MEMORY_OS_PRD.md

| Phase / requirement | Status | Evidence | What's missing |
|---------------------|--------|----------|----------------|
| **Phase 1 — MVP (table + engine + tests)** | ✅ Shipped | `030_agent_memory.sql`/`.sqlite.sql` (`agent_memory` table, scope/authority/confidence/ttl/forgotten_at, `(client_id, kind, created_at)` index). `lib/memory.js` = `remember`/`recall`/`forget` with scope clamp, precedence, decay. Tests `memory.test.js`, `authz.test.js`/`authz.integration.test.js`. | — |
| **Phase 2 — grounding + first producer** | ✅ Shipped | `lib/memoryGrounding.js` gates assertion via the evidence path; `lib/memoryProducer.js` + `lib/memoryCapture.js` write efficacy/recovery claims. Tests `memory.grounding.test.js`, `memoryProducer.test.js`, `memoryCapture.test.js`. | — |
| **Phase 3 — scheduler sweep + REST + UI panel** | ✅ Shipped | `routes/memory.js` full REST surface (`POST`/`GET /:clientId`/`GET /` fleet/`DELETE /:id` + `/health`) with `requireAgency` / `scopeClientParam`; `lib/memoryGovernor.js`, `lib/memoryHealth.js` for compaction/governance. (Minimal read-only "what I remember" panel is the lightest-touch piece — surfaced via the Intelligence/memory routes.) | — |
| **Phase 4 — embedding / vector recall (optional)** | ✅ Shipped | `lib/embeddings.js` (`localEmbed`), `lib/memorySemantic.js` (`semanticRecall`); `routes/memory.js` `?q=` triggers semantic search. Test `embeddings.test.js`. | The optional vector phase is present (local embedder); a hosted/production embedder is pluggable but not configured. |

---

## Surprises / notes for onboarding

- The plan's closing line ("Nothing here has been built") is the single most
  misleading sentence in the repo: **Phases 0–2 are fully shipped** and the
  **Memory OS is shipped through its optional Phase 4** (vector recall).
- **Phase 2 was delivered re-shaped**: instead of the literal
  `/api/insights/forecast|drivers|pacing` URLs, the analytics are an autonomous
  intelligence **feed** (`/api/insights/*`) plus `/api/metrics/:clientId/anomalies`,
  backed by in-house stats in `lib/baselines.js` (no heavy stats deps, as the plan
  recommended).
- **Phase 3 is the real gap**: `Explore.jsx` makes the dashboard genuinely
  dynamic for *ad-hoc* exploration, so it's easy to overestimate completeness — but
  the **persistence layer (`dashboards` table) and the drill-down/builder are
  absent**. If you're asked to "finish the composable UI," that's the work: the
  `012_dashboards.sql` migration, `routes/dashboards.js`, the `QueryWidget`/
  `QueryBuilder` components, and click-to-drill in `Explore.jsx`.
- **Phase 4 is half-built**: alert rules + delivery storage exist, but
  rule evaluation isn't wired into cron and narratives aren't yet grounded in
  driver analysis.
- The repo has grown well beyond the plan: a **Make remediation** subsystem
  (`031`/`032` migrations, `MAKE_REMEDIATION_PRD.md`, `routes/makeRemediation.js`)
  and a large `lib/scope*`/`lib/pulse*`/`lib/brief*` intelligence surface exist
  that the original transformation plan never enumerated.
