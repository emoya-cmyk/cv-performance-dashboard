# Performance Dashboard — Handoff Brief

_Last updated: 2026-06-04 · HEAD `4fe8845` on `main` (local-only, never pushed)_

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
- **Tests:** `node --test` (1959 currently green). DB seam: unset `DATABASE_URL` +
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
- **Launch hardening (P0–P2)** — security headers, a login brute-force throttle, an AI cost cap,
  an always-on external **cron heartbeat** (the free-tier-sleep fix), and a cold-start/empty-state
  sweep proving a freshly-onboarded client with zero data has no sharp edges. Details in §4.

_(The in-tool task list #1–#256 has the full granular history.)_

---

## 4. What was just finished — the launch-hardening sprint (✅ DONE)

Took the build from "great craft, not yet launch-ready" to **onboarding-ready**. Five steps, each
its own local-only commit, both gates green at every step:
**auth/tenant-isolation → P0 security & cost → P1 always-on cron → P2 cold-start → hygiene.**
Full commit lineage (all on `main`, never pushed):
`511e54d` → `52ca9a9` → `553bacb` → `20435df` → `feb9fa9` → `f340d16` → `08d2911` → `ed98f7a`.

### 4.1 Authorization / tenant isolation — the onboarding unblock (commit `511e54d`)

**Why:** the trigger question was _"are we ready to start onboarding clients?"_ → the blocker was
that authentication existed but **authorization did not**: any logged-in `client` could read or
mutate another tenant's data by changing the `:clientId` in the URL (a classic multi-tenant IDOR),
and `POST /api/query` would honor `clients:'all'` from any caller.

**What shipped (17 files, +679/−52):**

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

**Verified:** API gate **1907/1907** at the time; FE `vite build` clean.

### 4.2 P0 — security headers, login throttle, AI cost cap

- **Security headers** (`middleware/securityHeaders.js`, commit `553bacb`) — hand-rolled (no
  `helmet` dependency), mounted **first** in `server.js`: HSTS, `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy`, a conservative `Content-Security-Policy`, and
  `x-powered-by` disabled. `trust proxy` = 1 (correct client IPs behind Render's proxy).
- **Login brute-force throttle** (`middleware/rateLimit.js`, commit `20435df`) — a dependency-free
  fixed-window limiter mounted **before** the auth router, so repeated failed logins from one IP get
  `429`ed. **Test seam:** the limiter self-skips when `NODE_ENV==='test'` unless
  `FORCE_RATE_LIMIT==='1'`, so `node --test` is unaffected (a dedicated test sets the flag to prove
  the 429).
- **AI cost cap** (`middleware/aiBudget.js`, commit `feb9fa9`) — wraps the same limiter around the
  **paid** AI endpoints (recap, brief, portfolio-brief, `ask`) at a default **60 calls/hour/caller**
  (override with `AI_RATE_MAX`). The pure-DB AI reads are deliberately **not** capped. Inherits the
  same `node --test` bypass.

### 4.3 P1 — always-on cron heartbeat (commit `f340d16`)

**Why:** the autonomy story depends on the nightly sweeps actually firing. On Render's **free tier
the web service sleeps after ~15 min idle**, which kills the in-process `node-cron` scheduler — so
"autonomous" was true in code but not in prod.

**What shipped:** `routes/cron.js` + `lib/heartbeat.js`, mounted **outside** `requireAuth`:
- `POST /api/cron/heartbeat` — bearer-gated by `CRON_SECRET` (`cronAuth`). Runs the idempotent job
  set `['sync','watchdog','insights']` (default body = all three, in order; or pass `{"jobs":[…]}`).
  **Fails CLOSED** — `503` if `CRON_SECRET` is unset, `401` on a wrong/missing bearer. Unknown job →
  `400` (the weekly client **digest is deliberately not reachable here**).
- `GET /api/cron/health` — public, reports `armed: true/false` (whether `CRON_SECRET` is set) and
  the job catalog; never echoes the secret.
- Covered by `cron.test.js` (unit) + `cron.integration.test.js` (drives the real jobs over HTTP).

**Operator setup (Class-C — one-time, in the Render dashboard):**
1. Set `CRON_SECRET` on the **web service** to a long random value.
2. Create a **Render Cron Job** (or any external scheduler — UptimeRobot, GitHub Actions, etc.).
3. Schedule it every ~10–15 min to `POST https://<app>.onrender.com/api/cron/heartbeat` with header
   `Authorization: Bearer <CRON_SECRET>` (the **same** value). Body optional.
4. Verify `GET /api/cron/health` → `{"armed": true}`.

(Alternatively, upgrade the web service off the free tier so it never sleeps and the in-process
scheduler runs — then the heartbeat is just a redundant safety net.)

### 4.4 P2 — cold-start / empty-state sweep (commit `08d2911`)

Proves a **freshly-onboarded client with zero data has no sharp edges.**
`test/coldStart.integration.test.js` (8 tests) seeds exactly one client with **no** facts / reports /
connections and drives the whole read surface (agency + client tokens) over HTTP, asserting: **no
`5xx`**, **no `NaN`/`Infinity`** anywhere in the raw response text, and **no false
`"severity":"critical"`** alarm on an empty book. Empty-state shapes are exact (insights feed `200`
with `by_severity.critical===0`, connections `[]`, reports `[]`). The AI layer degrades gracefully
**without `ANTHROPIC_API_KEY`**: recap/brief return deterministic **`200` templates**,
`POST /api/ai/ask` returns **`503` (NO_AI)**. Hardened `lib/metricsCore.js#derive` so every KPI is a
finite number on a degenerate/empty/`undefined` row (golden-parity unaffected).

### 4.5 Hygiene (commit `ed98f7a`)

Removed two unreferenced May-25 debug scripts (`api/check_db.js`, `api/check_db2.js`) to keep the
deploy surface clean. Verified unreferenced; test count unchanged (1959).

### Operator gates before go-live (Class-C — never self-healed in code)
The sprint closed everything automatable. What remains is **operator-only** (secrets, OAuth, host
plan) — automate up to the click, then a human does it:
1. **`JWT_SECRET` in production.** `middleware/auth.js` falls back to the literal
   `'dev-secret-change-in-production'` if unset → tokens would be forgeable. On Render this is
   handled automatically (`render.yaml` → `generateValue: true`); **off Render, an operator must set
   it.**
2. **`CRON_SECRET`** — set on the web service **and** the Cron Job (same value) to arm the heartbeat
   (§4.3). Unset = the cron endpoint is disabled (503, fails closed).
3. **`ANTHROPIC_API_KEY`** — **optional.** Unset = AI recap/brief render deterministic templates
   (`200`) and `POST /api/ai/ask` returns `503`; everything else works. Set it (Render dashboard;
   `sync: false` stub now in `render.yaml`) to enable LLM narration. Optional `AI_RATE_MAX` (default
   60/hr/caller) caps spend.
4. **Always-on host** — either run the external Cron Job (§4.3) or upgrade the web service off the
   free tier so it never sleeps.
5. **Connect each client's accounts** — the operator's one recurring job: the client's ad/CRM OAuth
   (Google Ads/GBP/GA4/LSA, Meta, GHL). This is the only thing the tool can't do for itself.
6. **Auth-provisioning review** — how `client`/`agency` users are created (`routes/auth.js`):
   login/signup, password storage, token expiry/refresh. Not yet audited.
7. **Public surfaces are by design** (token-validated) but re-confirm: `GET /api/share/:token`,
   `GET /api/unsubscribe/:token`, the HMAC webhook receivers, and `/api/agency`
   (GET public / PUT self-guards).

---

## 5. What's next (suggested order for the new chat)

> **The entire build backlog #1–#266 is complete** — all intel-vN feature work (through the
> intel-v14 D11 stability cue, `4fe8845`) and the full launch-hardening sprint are done, both gates
> green. Nothing code-side is open. What remains to go live is **operator-only** (Class-C) plus one
> un-audited code slice:

1. **Provision the operator gates** — §4's "Operator gates" 1–5: deploy with `JWT_SECRET` (auto on
   Render), set `CRON_SECRET` + wire the Render Cron Job, optionally set `ANTHROPIC_API_KEY`, and
   pick the always-on path (cron vs. paid plan).
2. **First client onboarding flow** — create a client (`POST /api/clients`, agency-only ✅), connect
   that client's ad/CRM accounts (the operator's one job), watch the first sync + rollup and the
   first nightly intelligence sweep land.
3. **Auth-provisioning pass** over `routes/auth.js` (gate 6) — the last un-audited slice: login/
   signup, password storage, token expiry/refresh. The only remaining code work before onboarding.

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
- **Class-C invariant:** credentials / OAuth / secrets (`JWT_SECRET`, `CRON_SECRET`,
  `ANTHROPIC_API_KEY`, account connections, the always-on host plan) are never self-healed in code —
  automate up to the click, then hand off exact steps (see §4 "Operator gates").
