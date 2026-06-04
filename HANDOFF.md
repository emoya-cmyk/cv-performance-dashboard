# Performance Dashboard — Handoff Brief

_Last updated: 2026-06-04 · HEAD `511e54d` on `main` (local-only, never pushed)_

Start a new chat with this file. It states **what the tool is**, **what's built**,
**what was just finished**, and **what's next** to get to client onboarding.

---

## 1. Objective (the North Star)

A **multi-tenant agency performance dashboard** that is:

- **Self-sustaining & autonomous** — runs on its own cadence; the only human job is
  connecting the accounts it pulls from. No operator in the happy path.
- **Self-improving** — the intelligence layer calibrates its own baselines, grades its
  own forecasts/alerts against outcomes, and tunes its sensitivity from what actually happened.
- **Eye-poppingly accurate & innovative** — grounded numbers only (every AI sentence is
  verified against a deterministic evidence pack), with a live, narrated intelligence feed.

Two roles, single-agency-per-deploy:
- `agency` — sees all clients (`client_id = null`).
- `client` — pinned to exactly one `client_id`.

---

## 2. Architecture at a glance

```
React + Vite + Tailwind (src/)            Express + node-postgres / SQLite (api/)
  Intelligence.jsx (agency)                 routes/*       REST surface (per-route authz)
  ClientView.jsx  (/my-dashboard)           lib/*          pure, tested engines
  ExecView, Explore, AskBox (shared)        semantic/*     query compiler over fact grain
  useLiveStream (SSE)                        scheduler.js   nightly sweeps + Monday digest
                                             db.js          Postgres in prod, SQLite in test
```

- **Data spine:** connectors write the **atomic fact grain** `fact_metric`; `lib/rollup.js`
  rebuilds the legacy `weekly_reports` rollup (parity-tested). Connectors with `fetchFacts`:
  Google Ads, GHL, Meta, LSA, GBP, GA4.
- **Two query paths over the grain:**
  - `lib/ask.js` `compileQuery` (NL → validated spec → safe SQL → grounded answer) — **scoped**.
  - `semantic/compile.js` `runQuerySpec` (powers `POST /api/query`) — honors `clients:'all'`,
    so it is **clamped in the route** for `client` callers (see §4).
- **Tests:** `node --test` (1907 currently green). DB seam: unset `DATABASE_URL` +
  `SQLITE_PATH` → ephemeral SQLite, set **before** any `require('../db')`.

---

## 3. What's already built

- **Ingestion & rollup** — atomic `fact_metric`, `lib/facts.js` adapters, `lib/rollup.js`,
  per-connector `fetchFacts`, golden parity test.
- **Grounded AI** — `lib/evidence.js` (deterministic pack), `lib/ai.js` (Anthropic call +
  grounding verifier that rejects ungrounded sentences), `lib/recap.js`, folded into the
  Monday email digest.
- **Ask-your-data** — NL questions with comparisons, mover suggestions, follow-ups,
  "why?" contribution/explain, forecast answers, goal-pacing, and prescriptive advice.
- **Semantic query API** — `POST /api/query` + Explore view, KPI cards, CSV export,
  shareable deep-links.
- **Autonomous intelligence layer (intel-v2 → intel-v14)** — self-calibrating baselines &
  insights; deterministic forecasts with self-tuned prediction intervals & calibrated alarms;
  driver attribution; client health/triage; peer benchmarking; connection-health **self-healing**
  (retry/backoff, token-expiry detection, watchdog heartbeat); root-cause linking; recovery
  classification ("what we fixed"); cross-client systemic detection; trajectory early-warning;
  goal pacing; action→outcome **efficacy learning** + escalation; a **Daily Pulse** sub-system
  (intra-week early-warning → diagnosis → reliability → triage → accuracy → self-tuning →
  briefing → continuity → morning brief → narration health/delivery/impact → lead-policy
  governance/audit/remediation); consumer-engagement learning; channel reallocation + efficacy
  + stability; an **impact ledger**; live SSE streaming with freshness badges; and a
  scope-narrative nowcast stack (delta, trend, nowcast + accuracy, calibrated band, calibrated
  voice, corroboration, coherence, materiality, momentum, stability).
  Every agency-only signal has a **leak-proof test** proving it never reaches the client surface.

_(The in-tool task list #1–#256 has the full granular history.)_

---

## 4. What was just finished — the auth layer (✅ DONE, this is the unblock)

**Why:** the trigger question was _"are we ready to start onboarding clients?"_ → the blocker was
that authentication existed but **authorization did not**: any logged-in `client` could read or
mutate another tenant's data by changing the `:clientId` in the URL (a classic multi-tenant IDOR),
and `POST /api/query` would honor `clients:'all'` from any caller.

**What shipped (commit `511e54d`, 17 files, +679/−52):**

- New `api/middleware/authz.js` — `{ sameId, requireAgency, scopeClientParam, scopeClientId }`,
  layered **on top of** the existing `requireAuth` (which only authenticates the JWT).
  - `requireAgency` → 403 unless `req.user.role === 'agency'`.
  - `scopeClientParam(param='clientId')` → agency passes; `client` passes **only** when the
    route's id matches its own `client_id`; otherwise 403.
  - `scopeClientId(req)` → the caller's own `client_id` for a `client`, else `null`.
- **Applied to every clientId-bearing surface:**
  - `scopeClientParam` on all per-client GETs — metrics (×4), reports (×2), goals, updates,
    campaigns, `insights/:clientId`, `clients/:id`, `clients/:id/email`, `ai` recap/brief.
  - blanket `router.use(requireAgency)` on **connections, shares, sync**; and on every
    agency-only mutation/read (clients create/update/delete, reports POST, goals PUT,
    updates PUT, campaigns CUD, `metrics GET /`, the insights agency feed, email PUT).
  - `GET /api/clients` stays **row-filtered** by role (a client sees only itself).
  - `POST /api/query` is **behaviorally clamped** for `client`: `clients` pinned to the caller
    **and** any forged `dim:'client'` filter stripped (this is the path `compile.js` left open;
    `/ask` was already scoped via `compileQuery`).
- **Tests:** `api/test/authz.test.js` (19 unit) + `api/test/authz.integration.test.js`
  (leak-proof REST — real routers behind real `requireAuth`, real JWTs, Node `http` harness on
  `app.listen(0)`; asserts the 403 boundary on every scoped GET, client denial on every
  agency-only surface, list-level row filtering, and the `POST /api/query` clamp incl. the
  forged-filter bypass).

**Verified:** API gate **1907/1907**; FE `vite build` clean.

### Boundaries — what this fix does NOT cover (read before onboarding)
This closed **authorization/tenant-isolation**. It deliberately did not touch **authentication
provisioning**. Before real tenants go live, review:
1. **`JWT_SECRET` in production.** `middleware/auth.js` falls back to the literal
   `'dev-secret-change-in-production'` when the env var is unset. **An operator must set a real
   `JWT_SECRET` in the production environment** (Class-C: a secret — never self-healed in code).
   With the dev default, tokens are forgeable.
2. How `client`/`agency` users are **provisioned** (`routes/auth.js`) — login/signup, password
   storage, token expiry/refresh. Not yet audited here.
3. The intentionally-**public** surfaces are by design and token-validated, but re-confirm:
   `GET /api/share/:token` (public snapshot), `GET /api/unsubscribe/:token`, the webhook
   receivers (HMAC-verified via raw-body capture), and `/api/agency` (GET public / PUT self-guards).

---

## 5. What's next (suggested order for the new chat)

1. **Onboarding readiness review** — items 1–3 in §4's boundaries. Start with **setting
   `JWT_SECRET`** (operator action) and a quick pass over `routes/auth.js`.
2. **Client onboarding flow itself** — creating a client (`POST /api/clients`, agency-only ✅),
   connecting that client's ad/CRM accounts (the operator's one job), first sync + rollup,
   first nightly intelligence sweep.
3. **#257 — the one open intel task** (deferred, additive, pure UI): _intel-v14 D11 (c/d):
   stability cue on the shared `NowcastStrip` (both surfaces)._ The engine half (D11 a/b) is
   already done; this is the front-end cue only.

---

## 6. Operating conventions (keep these)

- **Gates run SEPARATELY — never `&&`-batched, never in parallel:**
  - API: from `api/` → `node --test`
  - FE: from project root → `cd /Users/ernestomoya/Desktop/performance-dashboard && npx vite build`
  - Keep **both** green at every step.
- **Commits are LOCAL-ONLY on `main` — NEVER push.** Stage explicit files; commit with
  `--no-verify` and the trailer:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- **Cadence:** `a` = pure module + unit tests; `b` = wire into engine/route + read endpoint +
  surface. Agency-only signals must never ride a per-client/shared payload — prove it with a
  leak-proof test.
- **Test DB seam:** set `delete process.env.DATABASE_URL` + `process.env.SQLITE_PATH=<tmp>`
  (and `JWT_SECRET` for authz tests) **before** any `require('../db')`/router; `await db.migrate()`;
  unlink the `db`, `-wal`, `-shm` files in `after()`.
- **Sandbox quirks:** `node -e` and `git log` may print nothing to stdout (use
  `git rev-parse | cat`); `grep` treats `semantic/compile.js` and `routes/sync.js` as binary —
  use Read, not grep, on those.
- **Class-C invariant:** credentials / OAuth / secrets (e.g. `JWT_SECRET`, account connections)
  are never self-healed in code — automate up to the click, then hand off exact steps.
