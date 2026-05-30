# Performance Dashboard → Dynamic Analytical Platform
## Transformation Design Doc (review before any code)

**Status:** proposal · **Author:** analysis pass · **Date:** 2026-05-29
**Scope:** turn the current weekly-snapshot reporting app into a composable, drill-down, forecast-capable analytical platform — without breaking the existing client-facing product during the migration.

---

## 0. Executive summary

The app today is a **wide, weekly, pre-aggregated snapshot table with polished narrative views on top.** It is excellent at *reporting* (telling a client what happened last week in plain English) and structurally incapable of *analysis* (letting someone explore *why*, at an arbitrary grain, over an arbitrary range).

The single load-bearing constraint:

> Connectors fetch granular per-campaign/per-week data and **aggregate it away into weekly buckets before storage** (`api/connectors/googleAds.js:108-141`). The analytical ceiling is set at *ingest*, not in the UI. No amount of front-end work can drill into data that was discarded before it hit the database.

**The transformation is a layered rebuild of the data → semantic → query → UI spine**, delivered in 5 independently-shippable phases, with the current product kept fully working throughout via a backward-compatible rollup.

### Design principles
1. **Never break the live product.** `weekly_reports` stays alive as a derived rollup; existing endpoints become thin wrappers. Every phase ships behind a no-breaking-change guarantee.
2. **Define metrics once.** A semantic layer replaces hardcoded `derive()`/`AGG` so a new metric never again requires a schema migration or a code change in five files.
3. **Store atomic, aggregate on read.** Keep the finest grain the connectors can give us; compute rollups and ratios at query time (cached).
4. **Dependency-light.** Implement stats (z-score, EWMA/Holt-Winters) in-house (~150 LOC) rather than pulling heavy packages; stay on the existing React/recharts/Express/pg stack.

### Target architecture
```
┌─────────────┐   fetchFacts()   ┌──────────────────────────────────────┐
│ 6 Connectors │ ───────────────► │ INGEST: dim_entity + fact_metric     │  ← atomic grain
└─────────────┘                  │        (daily, entity-level, tidy)    │
                                  └──────────────────┬───────────────────┘
                                                     │ rebuildRollup()
                                  ┌──────────────────▼───────────────────┐
                                  │ weekly_rollup  (back-comat, cached)   │  ← keeps current views alive
                                  └──────────────────┬───────────────────┘
        ┌────────────────────────────────────────────┤
        │ SEMANTIC LAYER  (metric + dimension registry)│  ← define-once
        └────────────────────────────────────────────┬┘
                                  ┌───────────────────▼──────────────────┐
                                  │ QUERY API   POST /api/query           │  ← arbitrary range / groupBy / compare
                                  │ INSIGHTS    /api/insights/*           │  ← anomaly / forecast / drivers
                                  └───────────────────┬──────────────────┘
        ┌────────────────────────────┬────────────────┴───────────────┐
   existing views (wrappers)   QueryWidget + builder            alert engine
   Dashboard/ExecView/ClientView  custom dashboards, drill-down   (scheduler)
```

---

## 1. Current state (one-paragraph recap)

Express + React(Vite) + Postgres/SQLite auto-select. One fact table `weekly_reports (client_id, week_start, ~50 wide columns)`; support tables `clients, client_connections, campaigns, client_goals, client_updates, report_shares, sync_runs, agency_settings`. Six connectors with a uniform contract → `sync.js` smart-upsert → `metrics.js` (`AGG` SUM/AVG → `derive()` ratios → period-over-period + 12-wk trend + fixed-threshold anomaly). SSE real-time, webhook receivers (HMAC), white-label, public shares, weekly email digest. Polished narrative views. **~12,135 LOC.**

**Gaps that block "sophisticated/dynamic":** grain frozen at weekly; date ranges are 4 hardcoded enums; no drill-down/pivot; descriptive-only analytics (no forecast, no statistical anomaly, no attribution, no driver analysis); zero user configurability; no semantic layer; N+1 agency queries; pull-only alerting.

---

## 2. 🔴 Fix first — `sql` vs `sql_count` schema split (latent production-breaker)

Independent of the rebuild, this will break the metrics endpoint the moment Postgres is wired up:

| Location | Uses |
|---|---|
| `api/migrations/001_initial.sql:93` | column **`sql`** (Postgres) |
| `api/migrations/001_initial.sqlite.sql:73` | column **`sql_count`** (SQLite) |
| `api/routes/metrics.js:35` | reads **`SUM(sql_count)`** |
| `api/connectors/ghl.js:149-160` | writes field **`sql`** |

**Consequences:**
- **On Postgres** (the migration you've been attempting): every `metrics.js` query references `sql_count`, which doesn't exist → `/api/metrics/*` **500s on every call.**
- **On SQLite** (current ephemeral prod): the GHL connector emits key `sql`, but the column is `sql_count`; `upsertWeeklyReport` builds the column list from the row keys → the GHL upsert references a non-existent `sql` column → **GHL sync errors** and the SQL-qualified metric is never populated.

**Fix (standardize on `sql_count` everywhere):**
1. `001_initial.sql:93` → rename `sql` → `sql_count` (or add migration `008_fix_sql_count.sql` with `ALTER TABLE weekly_reports RENAME COLUMN sql TO sql_count` guarded for existing Postgres DBs).
2. `ghl.js` → emit `sql_count` instead of `sql`.
3. Verify `seed.js` / any manual report entry uses `sql_count`.
4. Add a golden test asserting `/api/metrics/:id` returns 200 on both backends.

> Do this **before** the Postgres cutover regardless of whether the larger rebuild proceeds.

---

## 3. Phase 0 — Preserve the atomic grain *(foundational unlock)*

**Goal:** stop discarding granularity. Land a daily, entity-level, tidy fact table + dimensions. Keep `weekly_reports` as a derived rollup so nothing downstream changes yet.

### 3.1 Schema (new migration `010_atomic_grain.sql`)
```sql
-- Channel dimension (seeded, static)
CREATE TABLE dim_channel (
  id       SMALLINT PRIMARY KEY,
  key      TEXT UNIQUE NOT NULL,   -- google_ads, meta, lsa, gbp, ga4, ghl, organic
  label    TEXT NOT NULL,
  category TEXT                    -- paid | local | crm | organic
);

-- Entity dimension (campaign / ad group / keyword / account), self-referential hierarchy
CREATE TABLE dim_entity (
  id          BIGSERIAL PRIMARY KEY,
  client_id   UUID    NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  channel_id  SMALLINT NOT NULL REFERENCES dim_channel(id),
  entity_type TEXT    NOT NULL,    -- account | campaign | ad_group | ad | keyword
  external_id TEXT    NOT NULL,    -- platform id
  parent_id   BIGINT  REFERENCES dim_entity(id),
  name        TEXT,
  status      TEXT,
  attrs       JSONB   NOT NULL DEFAULT '{}',  -- geo, device, service_type, …
  UNIQUE (client_id, channel_id, entity_type, external_id)
);

-- Atomic fact: tidy/long. New metric = new ROW, never a migration.
CREATE TABLE fact_metric (
  client_id    UUID     NOT NULL,
  date         DATE     NOT NULL,
  channel_id   SMALLINT NOT NULL REFERENCES dim_channel(id),
  entity_id    BIGINT   REFERENCES dim_entity(id),   -- NULL = channel/account grain
  metric_key   TEXT     NOT NULL,                    -- spend, clicks, impressions, leads, conversions, revenue, calls, …
  metric_value NUMERIC  NOT NULL,
  PRIMARY KEY (client_id, date, channel_id, COALESCE(entity_id, 0), metric_key)
);
CREATE INDEX ix_fact_client_date   ON fact_metric (client_id, date);
CREATE INDEX ix_fact_client_metric ON fact_metric (client_id, metric_key, date);
CREATE INDEX ix_fact_entity        ON fact_metric (entity_id);
-- When volume warrants: PARTITION BY RANGE (date) monthly.
```

**Why tidy/long, not wide-daily?** It removes "new metric = migration" permanently (gap ⑥/⑦), makes arbitrary `group by` trivial, and matches a semantic layer's assumptions. Cost = more rows + pivot-on-read; mitigated by indexes, monthly partitioning, and cached rollups. *(Hybrid alternative in §10 Open Decisions.)*

### 3.2 Connector contract change
**Old:** `fetchStats(creds, weeksBack) → [{ week_start, …wide fields }]`
**New:** `fetchFacts(creds, { since, until }) → { entities: [...], facts: [...] }`
```js
// facts[]: { date:'YYYY-MM-DD', channel:'google_ads',
//            entity:{ type:'campaign', external_id, name, parent_external_id?, attrs? } | null,
//            metric_key:'spend', value:Number }
```
- **`googleAds.js`** already pulls per-campaign rows — change `segments.week` → `segments.date`, **stop the weekly bucketing (delete lines ~108-141)**, emit one fact per (date, campaign, metric). ~Net simpler.
- **`ghl.js`** emits CRM facts at account grain (entity=null): `leads, mql, sql_count, closed_won, revenue`, plus per-channel lead counts as `leads` facts tagged to the detected channel.
- **`meta/lsa/gbp/ga4`**: same shape; entity=campaign where available, else account grain.
- Keep old `fetchStats` as a deprecated shim (delegates to `fetchFacts` + buckets) so legacy paths keep working until Phase 1 lands.

### 3.3 Sync changes (`api/routes/sync.js`)
- New `ingestFacts(clientId, channel, { entities, facts })`:
  1. upsert `dim_entity` rows, resolve `external_id → entity_id`,
  2. bulk-upsert `fact_metric` (ON CONFLICT … DO UPDATE),
  3. call `rebuildWeeklyRollup(clientId, affectedWeeks)`.
- `runSync` calls `connector.fetchFacts` when present, else falls back to `fetchStats` (smooth per-connector migration).
- Keep `sync_runs` logging + `broadcast('refresh')` unchanged.

### 3.4 Rollup compatibility (`rebuildWeeklyRollup`)
A JS function (transition) then a `MATERIALIZED VIEW` (steady state) that pivots `fact_metric` → the existing wide `weekly_reports` columns via `SUM(...) FILTER (WHERE metric_key=… AND channel_id=…)`. Triggered after each sync for affected weeks. **Result: `metrics.js` and every current view keep working untouched.**

### 3.5 Historical backfill (be honest about this)
- Past weeks already stored only as weekly aggregates **cannot be de-aggregated** to daily/campaign grain. Atomic data accrues **from cutover forward**, plus whatever each platform lets us re-fetch historically (Google Ads ~ up to the API's lookback). Keep historical `weekly_reports` rows as-is inside the rollup.

### 3.6 Files touched
`migrations/010_atomic_grain.sql` (new), `migrations/011_seed_dim_channel.sql` (new), all 6 `connectors/*.js`, `routes/sync.js`, new `lib/rollup.js`. **No frontend changes.**

---

## 4. Phase 1 — Semantic layer + dynamic query API

**Goal:** one composable query endpoint that supports arbitrary date ranges, comparison windows, group-by dimensions, and filters — replacing the 4 hardcoded period enums and the inline `AGG`/`derive`.

### 4.1 Metric & dimension registry (`api/semantic/registry.js`)
```js
export const METRICS = {
  spend:      { agg:'sum', from:'fact', match:{ metric_key:'spend' },   format:'currency' },
  leads:      { agg:'sum', from:'fact', match:{ metric_key:'leads' },   format:'int' },
  revenue:    { agg:'sum', from:'fact', match:{ metric_key:'revenue' }, format:'currency' },
  closed_won: { agg:'sum', from:'fact', match:{ metric_key:'closed_won' } },
  // derived (computed AFTER aggregation)
  roas:       { type:'ratio', num:'revenue',    den:'spend',  format:'multiple' },
  cpl:        { type:'ratio', num:'spend',      den:'leads',  format:'currency' },
  close_rate: { type:'ratio', num:'closed_won', den:'leads',  format:'percent'  },
};
export const DIMENSIONS = {
  channel:  { table:'dim_channel', key:'channel_id' },
  campaign: { table:'dim_entity',  key:'entity_id', where:"entity_type='campaign'" },
  date:     { grain:['day','week','month','quarter'] },
  geo:      { jsonb:'dim_entity.attrs->>geo' },
  device:   { jsonb:'dim_entity.attrs->>device' },
};
```
*(Ships as a JS module first; can move to DB-backed tables in Phase 3 for user-defined metrics.)*

### 4.2 Query API contract
```
POST /api/query        (requireAuth)
{
  "clients":  ["<uuid>"] | "all",
  "metrics":  ["spend","leads","roas"],
  "dateRange":{ "start":"2026-01-01", "end":"2026-03-31" },
  "compareTo":"previous_period" | "previous_year" | { "start":"…","end":"…" } | null,
  "groupBy":  ["channel","date:week"],
  "filters":  [{ "dim":"channel","op":"in","values":["google_ads","meta"] }],
  "orderBy":  [{ "key":"spend","dir":"desc" }],
  "limit":    500
}
→ 200
{
  "columns":[{ "key":"channel","type":"dim" },
             { "key":"spend","type":"metric","format":"currency" }, …],
  "rows":[ { "channel":"google_ads","spend":12450,"leads":83,"roas":3.4,
             "_compare":{ "spend":11200,… }, "_delta":{ "spend":0.11,… } }, … ],
  "meta":{ "grain":"week","rowCount":N,"generatedAt":"…",
           "coverage":{ "sources":4,"of":6 },"freshness":{ "google_ads":"2026-05-28T…" } }
}
```

### 4.3 Compiler (`api/semantic/compile.js`)
- Base metrics → `SUM(metric_value) FILTER (WHERE metric_key=…)` grouped by requested dims + date grain (`date_trunc`).
- Ratio metrics → computed in JS post-aggregation from their numerator/denominator columns (correct averaging — fixes the current `AVG(roas)` distortion at `metrics.js:38`).
- `compareTo` → second pass over the shifted window, zipped per row; `_delta` = pct change.
- All values parameterized; dimension/metric keys validated against the registry (injection-safe by allow-list).

### 4.4 Backward compat
Rewrite the existing endpoints as wrappers over the compiler:
`GET /api/metrics/:clientId` → `query({clients:[id], metrics:[…], dateRange: enum→range, compareTo:'previous_period', groupBy:['date:week']})`. Identical response shape; **views unchanged.** Add golden tests: old vs new must match within rounding.

### 4.5 Performance
- `weekly_rollup` / `monthly_rollup` materialized views for the common grains; the compiler picks the coarsest rollup that satisfies the requested grain, else hits `fact_metric`.
- Short-TTL (e.g. 60s) in-memory cache keyed by normalized-query hash.
- Kills the N+1 agency loop (`metrics.js:280-327`) — one grouped query replaces the per-client loop.

### 4.6 Files
`semantic/registry.js`, `semantic/compile.js`, `routes/query.js` (new); `routes/metrics.js` (→ wrappers); `server.js` (mount `/api/query`); `lib/cache.js` (new). Frontend `lib/api.js` gains `runQuery(spec)`.

---

## 5. Phase 2 — Advanced analytics (`/api/insights/*`)

Now that a daily series and a query layer exist:

| Endpoint | Method | Replaces / adds |
|---|---|---|
| `/api/insights/anomalies` | rolling mean+stddev per metric, **z-score** flag, seasonality-aware (same weekday/week-of-month) | the fixed `\|Δ\|>15/20%` at `metrics.js:251,312` |
| `/api/insights/forecast?metric=&horizon=` | **Holt-Winters / EWMA** on the daily series → projection + CI band | naive `BudgetSimulator` linear model |
| `/api/insights/pacing?clientId=` | actual-vs-goal pace, projected end-of-period, ETA-to-target | nothing today |
| `/api/insights/attribution?clientId=` | first / last / linear-touch from lead-source facts | string-inferred only |
| `/api/insights/drivers?metric=&range=` | decompose a metric Δ into contributing dimensions ("revenue −18%: Google Ads −$12k") | nothing today |

- Stats live in `api/lib/stats.js` (z-score, EWMA, Holt-Winters, linear regression) — ~150 LOC, no heavy deps (option: `simple-statistics`).
- These feed Phase 4's grounded narratives and the existing `verdictFor`/`buildStrategicHeadline` so copy cites *real causes*, not templates.

**Files:** `routes/insights.js`, `lib/stats.js`, `lib/forecast.js`, `lib/attribution.js` (new); mount in `server.js`.

---

## 6. Phase 3 — Composable / dynamic UI

**Goal:** the UI *becomes* dynamic — user-built views, arbitrary ranges, click-to-drill.

### 6.1 Schema (`012_dashboards.sql`)
```sql
CREATE TABLE dashboards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_scope TEXT NOT NULL,        -- 'agency' | 'client'
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE,  -- null for agency-wide
  name TEXT NOT NULL, layout JSONB NOT NULL DEFAULT '[]',
  created_by UUID, created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE dashboard_widgets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dashboard_id UUID REFERENCES dashboards(id) ON DELETE CASCADE,
  title TEXT, viz TEXT NOT NULL,    -- kpi | line | bar | stacked | table | treemap | funnel
  query JSONB NOT NULL,             -- a saved /api/query spec
  pos JSONB NOT NULL                -- {x,y,w,h}
);
```

### 6.2 Front-end
- `<QueryWidget spec viz />` — runs `/api/query`, renders the chosen recharts viz; the one component behind every widget. Build on existing `WidgetGrid.jsx`.
- `<DateRangePicker />` — arbitrary start/end + presets + compare toggle, emits into the query spec (retires the 4-enum `PERIOD_OPTS`).
- **Drill-down:** clicking a row dispatches a child query = parent spec + the clicked dim as a filter + the next finer grain; breadcrumb stack to navigate back.
- **Builder:** pick metrics + dimensions + viz → save to `dashboards`. Per-client default layouts; agency templates.
- Existing Dashboard/ExecView/ClientView remain as curated defaults (now powered by `/api/query`).

**Files:** `routes/dashboards.js` (new); `components/QueryWidget.jsx`, `components/DateRangePicker.jsx`, `components/QueryBuilder.jsx`, `pages/Explore.jsx` (new); `lib/api.js` (+dashboard CRUD).

---

## 7. Phase 4 — Intelligence layer

- **Alert rules** (`013_alerts.sql`): `alert_rules(client_id, metric, op, threshold, window, notify_channel)`; evaluated inside the existing `scheduler.js` cron → `PushNotification` / email / Slack when breached. Replaces pull-only anomalies.
- **Grounded narratives:** pipe `/api/insights/drivers` output into `buildStrategicHeadline`/`verdictFor` so the story states the actual cause.
- **Recommendations:** ROAS-by-campaign (now available) → budget-reallocation suggestions in ExecView/ClientView.

**Files:** `routes/alerts.js`, `lib/alertEngine.js` (new); `scheduler.js` (+eval pass); narrative generators in `ExecView.jsx`/`ClientView.jsx` (consume insights).

---

## 8. Cross-cutting concerns

- **Performance:** monthly partitioning of `fact_metric`; `weekly_rollup`/`monthly_rollup` matviews; query-hash cache; one grouped agency query (no N+1).
- **Backward compatibility:** `weekly_reports` preserved as a rollup; all current endpoints become wrappers; **zero breaking changes per phase.**
- **Testing:** golden-query tests (pre/post numbers must match); connector contract tests (`fetchFacts` shape); a fixture client with known data for insight math.
- **Security:** registry allow-list makes `/api/query` injection-safe; client-scoped row access enforced in the compiler; no new secrets in URLs.
- **Migration safety:** every migration guarded for existing Postgres + SQLite; `db-sqlite.js` parity checked for each new table.

---

## 9. Sequencing, effort & reversibility

| Phase | Ships | Rough effort | Reversible? | Depends on |
|---|---|---|---|---|
| **Fix** sql_count | correct metrics on Postgres | XS | yes | — |
| **0** atomic grain | granular data starts accruing | L | yes (rollup keeps old path) | Fix |
| **1** query API | arbitrary ranges/compare/groupBy; N+1 gone | M | yes (wrappers) | 0 |
| **2** insights | forecast / z-score / drivers / pacing | M | yes (additive) | 1 |
| **3** composable UI | custom dashboards + drill-down | L | yes (additive) | 1 |
| **4** intelligence | alerts + grounded narratives | M | yes (additive) | 2 |

**Recommended order:** Fix → 0 → 1 → (2 ∥ 3) → 4. Phases 2 and 3 can proceed in parallel once 1 lands.

### Risks
- **Connector volume** at daily/entity grain → more API calls/rows: mitigate with incremental backfill windows + rate-limit respect + partitioning.
- **History is not recoverable** below weekly for already-aggregated past (see §3.5) — set expectations.
- **Scope creep** — each phase is a clean stopping point; the product is shippable after any of them.

---

## 10. Open decisions for you

1. **Fact model:** tidy/long `fact_metric` (recommended — max flexibility) **vs** hybrid (typed wide-daily per source + a small generic table for custom metrics — more efficient, slightly less flexible). *Affects §3.1.*
2. **Rollup mechanism:** JS `rebuildWeeklyRollup` function (incremental, simple) **vs** `MATERIALIZED VIEW` (declarative, periodic refresh). Recommend function during transition → matview at steady state.
3. **Stats:** in-house `lib/stats.js` (no deps) **vs** add `simple-statistics`. Recommend in-house first.
4. **Cutover for Postgres:** do the `sql_count` fix + Phase 0 schema **before** the DATABASE_URL switch, so the first Postgres boot is already on the corrected, atomic-ready schema.
5. **Start point:** confirm we begin with **Fix + Phase 0**, or take the faster-but-shallower **Phase 1 on current weekly data** first (dynamic ranges/compare without true drill-down).

---

*End of plan. Nothing here has been built — this is for review.*
