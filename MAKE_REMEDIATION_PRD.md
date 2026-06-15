# PRD: Make.com Autonomous Remediation System

**cli_framework · Layer B Extension** · Author: Ernesto | Cardone Ventures CRM Stack
_Status: **~85% complete** (repo-side: **100%**) · Version 2.0 — Consolidated · Last updated: 2026-06-15_

> **Build progress: ~85% complete / ~15% remaining.** Every remaining item is **external** to
> this repo (Make.com scenario config, n8n per-vendor flows, the `cli_framework` field map) and
> cannot be built from this session. The full repo-side surface this codebase can own is **done**.
> See **[§ Build tracker](#build-tracker)**.

> **Where this lives.** The canonical home for this system is the **`cli_framework`** repo
> (this is its Layer B extension). The *repo-side slice* — the Performance DB schema, the
> error-handler intake webhook, the deterministic classifier, and conditional Slack — is
> implemented here in `cv-performance-dashboard` because that is where the Performance DB and
> the existing webhook receivers (GHL/HubSpot/Supermetrics) already live. The n8n orchestrator
> hot path and the 158-entry field-equivalence map remain external. See
> **[§ Implementation in this repo](#implementation-in-this-repo)** and
> **[§ Porting to cli_framework](#porting-to-cli_framework)** below.

---

## Implementation in this repo

Phase 1 (Foundation) repo-side components, all under `api/`:

| Component | File | PRD ref |
|---|---|---|
| Deterministic classifier, retry schedule, payload validation, Wilson feedback + confidence apply, Slack shapes, payload hashing | `api/lib/makeRemediation.js` | FR-2, FR-3, FR-1, FR-9, FR-8, FR-6 |
| Error-handler intake webhook + per-tier remediation, dead-letter writes, breaker-check-before-retry, LLM enrichment, confidence application | `api/routes/webhooks/makeRemediation.js` | FR-1, FR-3–FR-6, FR-9 |
| Scheduled sweeps: Tier 1 batched digest, dead-letter 30-day retention, confidence store writer | `api/lib/makeRemediationSweeps.js` | FR-8, FR-4, FR-9 |
| Operator surface: fix-queue list/resolve, circuit-breaker manual override, stats, recurring-unknown pattern analysis | `api/routes/makeRemediation.js` → `/api/make-remediation/*` | FR-4, FR-5, Phase 3 |
| FR-1 coverage audit (Make API scenario handler check) | `api/scripts/auditMakeHandlers.js` | FR-1 |
| `make_remediation_log`, `make_dead_letter`, `make_circuit_breaker`, `make_scenario_confidence` (+ `batched_notified`) | `api/migrations/031`,`032` (`.sql`/`.sqlite.sql`) | FR-7, FR-4, FR-5, FR-9 |
| Tests (29 across 2 files: classification, fail-safe default, backoff, validation, feedback, confidence + freeze, hashing, alerts, digest dedup, retention) | `api/test/makeRemediation*.test.js` | — |
| Route mounts + 30-min digest & daily retention crons | `api/server.js`, `api/scheduler.js` | — |

**Design split.** `lib/makeRemediation.js` is a **pure** decision module (no I/O) so it can be
unit-tested in isolation and ported verbatim into `cli_framework`. The route owns all DB
writes and outbound Slack/LLM I/O. This mirrors the existing `lib/` ↔ `routes/` separation in
this codebase (e.g. `lib/opsRecovery` vs its callers).

### Endpoint

```
POST /api/webhooks/make-remediation
Header (optional): x-make-signature: <MAKE_WEBHOOK_SECRET>   # constant-time gate; skipped if unset
```

Minimum payload (FR-1 schema; request is `400`'d if any are missing):

```json
{ "scenario_id": "...", "execution_id": "...", "tenant_id": "...", "vendor": "GHL" }
```

Optional deterministic side-channel signals the classifier reads (FR-2):
`error_code`, `retry_count`, `refresh_token_available`, `signature_valid`,
`missing_fields` (array), `canonical_id_missing`, `field_map_miss`, `malformed_payload`,
plus `error_message`, `error_type`, `module_name`, `scenario_name`, `raw_payload`.

The response echoes the assigned `tier`, `reason`, `action`, and a directive for the n8n
orchestrator (e.g. `{ retry: true, delay_ms, attempt }` for Tier 0).

### Environment variables

| Var | Purpose | Default |
|---|---|---|
| `MAKE_WEBHOOK_SECRET` | Shared-secret gate on the intake endpoint | unset → no gate (dev) |
| `SLACK_WEBHOOK_URL` | Tier 2/3 immediate alerts (reuses `lib/alertDelivery`) | unset → Slack skipped |
| `ANTHROPIC_API_KEY` | Tier 3 LLM enrichment (FR-6) | unset → alert sent without enrichment |
| `MAKE_LLM_MODEL` | Enrichment model | `claude-sonnet-4-6` |

### Operator endpoints (`/api/make-remediation`, agency-only)

| Method | Path | Purpose |
|---|---|---|
| GET  | `/dead-letter?status=open` | List the operator fix queue (FR-4) |
| POST | `/dead-letter/:id/resolve` | Resolve a queued item |
| GET  | `/circuit-breakers` | Current breaker state per tenant+vendor |
| POST | `/circuit-breakers/clear` | Manual override to clear a trip (FR-5) |
| GET  | `/stats?days=7` | Success-metric rollup (tier mix, auto-resolution rate) |
| GET  | `/recurring-unknowns?days=14&min=2` | Tier 3 patterns → Tier 1 promotion candidates (Phase 3) |

---

## Build tracker

**Overall ~85% complete / ~15% remaining.** Phase 1: 7/8 · Phase 2: 4.5/6 · Phase 3: 4/4.
The entire remainder is **external** to this repo (🔒) — Make.com config, n8n flows, and the
`cli_framework` field map — so it cannot be built from this session. Everything this repo can
own is ✅.

### Phase 1 — Foundation (≈88%)
- 🔒 Universal error handler added to all Make scenarios — **external (Make.com config)**
- ✅ Coverage audit script (`scripts/auditMakeHandlers.js`)
- ✅ Webhook receiver endpoint
- ✅ Deterministic failure classifier
- ✅ Tier 0 retry logic + idempotency
- ✅ Tier 3 hard stop + immediate Slack
- ✅ `make_remediation_log` table
- ✅ End-to-end: failure → classify → log → notify (verified)

### Phase 2 — Intelligence (≈75%)
- ◐ Tier 1 sub-flows — ✅ classification + ✅ dead-letter fallback; 🔒 **active remap/contact
  search needs the `cli_framework` 158-entry field map**
- ✅ Dead-letter queue writer → operator fix queue (+ list/resolve endpoints)
- 🔒 Tier 2 per-vendor credential refresh execution — **external (n8n + vendor OAuth; credential
  vault is explicitly out of scope per this PRD)**
- ✅ Circuit breaker + manual override endpoint + check-before-retry (Session Rule 7)
- ✅ Tier 1 batched 30-min Slack summary (scheduled)
- ✅ Wilson-score feedback integration (per-event delta + scenario confidence store w/ freeze)

### Phase 3 — LLM (100%)
- ✅ Claude API enrichment on Tier 3 (env-gated, 10s timeout, non-blocking)
- ✅ Enrichment appended to Slack alert
- ✅ Enrichment logged to DB
- ✅ Pattern analysis: recurring Tier 3 surfaced as promotion candidates

### Remaining 15% — all external (blocked on access this session doesn't have)
1. **Make.com:** add the universal error handler to every scenario + run the audit script with
   `MAKE_API_TOKEN` to confirm 100% coverage.
2. **n8n:** orchestrator flows that honor the Tier 0 `delay_ms` retry directive and execute the
   per-vendor OAuth token refresh (GHL/HubSpot/Jobber/HCP).
3. **`cli_framework`:** wire Tier 1 active remap/contact-search against the field-equivalence map
   (repo currently dead-letters as the safe fallback). `lib/makeRemediation.js` ports verbatim.

---

## Porting to cli_framework

When `cli_framework` is in scope:

1. **`lib/makeRemediation.js` ports verbatim** — it is pure and dependency-free (only Node
   `crypto`). It is the single source of truth for the taxonomy and is the natural Layer B core.
2. The route's DB helpers assume a `pg`-compatible `query()` (this repo's `db.js`). In
   `cli_framework` (Python), reimplement intake/persistence against its DB layer but keep the
   classifier semantics identical — the unit tests double as the conformance spec. In
   particular, `api/test/makeRemediation.test.js` pins the **cross-tier precedence** (FR-2
   "evaluated in order"): retry-safe codes outrank auth, auth outranks data, `429` has no retry
   cap while timeouts promote at the cap boundary, `signatureValid` must be strictly `false` to
   trip, and the Tier 1 internal order is missingFields → canonicalId → fieldMap → malformed.
   Mirror these cases in the Python port.
3. The **field-equivalence map (158 entries)** and the **operator fix queue (Layer C)** already
   live in `cli_framework`; wire Tier 1 active remap there instead of the dead-letter fallback
   used here.

---

## Problem Statement

Make.com scenarios across the tenant stack fail regularly due to rate limits, auth expiration,
missing fields, and unknown errors. Every failure currently generates a Slack notification
requiring manual investigation and resolution. There is no self-healing mechanism. When
unavailable, failures accumulate unresolved, degrading data integrity and client deliverables
across 40+ tenants.

## Goal

Build a universal autonomous remediation system that:

- Classifies every Make scenario failure without human input
- Resolves known failure patterns automatically
- Escalates only when human judgment is genuinely required
- Logs every event to the performance DB regardless of outcome
- Reduces Slack noise to actionable alerts only

Applies universally to any scenario connecting GHL, HubSpot, AccuLynx, HCP, Jobber, or any
external system via webhook or scheduled trigger.

## Success Metrics

| Metric | Target |
|---|---|
| Auto-resolution rate (Tier 0/1) | ≥ 85% of all failures |
| Mean time to remediation (Tier 0) | < 3 minutes |
| Mean time to remediation (Tier 1) | < 15 minutes |
| Slack alerts reduced | ≥ 70% reduction vs baseline |
| False escalations (Tier 3 that were actually Tier 1) | < 5% |
| DB log coverage | 100% of all failure events |

## Architecture Overview

```
Make Scenario Fails
        │
        ▼
[Error Handler Module] ← built into every scenario
        │
        ▼
[Webhook → n8n Remediation Orchestrator]
        │
        ▼
[Failure Classifier — deterministic]
        │
   ┌────┼────────────┬──────────────┐
   │    │            │              │
Tier 0  Tier 1    Tier 2         Tier 3
Retry  Remap/    Auth/Cred     Hard Stop
Safe   Dead-letter Refresh     Escalate
   │    │            │              │
   └────┴────────────┴──────────────┘
                │
        [Performance DB Log]
                │
        [Slack — conditional per tier]
```

**Orchestrator:** n8n primary with deterministic classification; LLM (Claude) reserved for the
Tier 3 enrichment step only — zero LLM cost on the hot path.

## Failure Taxonomy

Every failure maps to exactly one tier; classification happens before any remediation action.

- **Tier 0 — Retry Safe** (auto-remediate, no Slack, log only): rate limit (429), transient
  timeout (502/503/504, retry 3× then promote to Tier 1), Make internal error, duplicate
  webhook (idempotent discard). Backoff: 30s → 2m → 10m → dead-letter.
- **Tier 1 — Data / Logic** (auto-remediate, batched Slack every 30 min, full log): missing
  required field, field-mapping mismatch, contact not found, malformed payload, canonical ID
  missing. Resolve via field-equivalence map → remap, else dead-letter.
- **Tier 2 — Auth / Credential** (attempt refresh, immediate Slack, circuit breaker): 401
  (refresh if `refresh_token` present, else manual), 403 forbidden, OAuth expired, invalid
  webhook signature. Circuit breaker trips on 2nd consecutive failure for a tenant+vendor pair.
- **Tier 3 — Unknown** (hard stop, no writes, LLM-enriched immediate Slack, human required):
  novel error code, cascading failures, data-integrity risk, schema-breaking change.

## Functional Requirements (summary)

- **FR-1 Universal Error Handler** — every scenario fires an HTTP POST to the remediation
  webhook on any failure, with full execution context; validated against the payload schema.
- **FR-2 Failure Classifier** — deterministic, evaluated in order; tier assigned before any
  action; unknown always → Tier 3.
- **FR-3 Tier 0 Remediation** — backoff schedule (immediate, +30s, +2m, +10m); idempotency
  check before every retry; exhausted → promote to Tier 1 + dead-letter; zero Slack.
- **FR-4 Tier 1 Remediation** — remap via field-equivalence map or dead-letter to the operator
  fix queue (never discarded; 30-day minimum retention); batched Slack.
- **FR-5 Tier 2 Remediation** — token refresh where a refresh token exists; circuit breaker on
  2nd consecutive failure with manual override; immediate Slack within 60s.
- **FR-6 Tier 3 Remediation** — no writes; capture payload hash; best-effort Claude enrichment
  (10s timeout, never blocks); immediate Slack; halt until manual clearance.
- **FR-7 Performance DB Logging** — `make_remediation_log` append-only; record created before
  remediation starts and updated with outcome; `execution_id` unique (idempotency guard).
- **FR-8 Slack Notification Schema** — Tier 0 none; Tier 1 batched 30-min summary; Tier 2/3
  immediate, structured per tier.
- **FR-9 Wilson-Score Feedback** — outcome → confidence delta (+0.05 remap verified, −0.10
  dead-lettered, −0.15 refresh failed, Tier 3 freezes the scenario score).

## Non-Functional Requirements

| Requirement | Target |
|---|---|
| Webhook receiver uptime | 99.5% |
| Classification latency | < 2 seconds |
| Tier 0 retry initiation | < 30 seconds from failure |
| Tier 2/3 Slack delivery | < 60 seconds from failure |
| DB write latency | < 5 seconds |
| Dead-letter retention | 30 days minimum |

## Claude Code Session Rules

1. Always classify before acting — no exceptions
2. Tier 3 = hard stop, no writes, ever
3. Dead-letter is always the safe fallback — when in doubt, dead-letter
4. Idempotency check before every retry and re-execution
5. Log first, act second — DB record created before remediation starts
6. Every DB write must include `tenant_id` and `execution_id`
7. Circuit breaker state must be checked before any Tier 2 retry
8. LLM is only used at the Tier 3 enrichment step — never in the hot path
