# PRD: Make.com Autonomous Remediation System

**cli_framework · Layer B Extension** · Author: Ernesto | Cardone Ventures CRM Stack
_Status: Phase 1 repo-side slice implemented in `cv-performance-dashboard` · Version 2.0 — Consolidated · Last updated: 2026-06-15_

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
| Deterministic classifier, retry schedule, payload validation, Wilson feedback, Slack shapes, payload hashing | `api/lib/makeRemediation.js` | FR-2, FR-3, FR-1, FR-9, FR-8, FR-6 |
| Error-handler intake webhook + per-tier remediation, dead-letter writes, circuit breaker, LLM enrichment | `api/routes/webhooks/makeRemediation.js` | FR-1, FR-3–FR-6 |
| `make_remediation_log`, `make_dead_letter`, `make_circuit_breaker` tables (Postgres + SQLite) | `api/migrations/031_make_remediation.sql(.sqlite.sql)` | FR-7, FR-4, FR-5 |
| Pure unit tests (classification order, fail-safe default, backoff, validation, feedback, hashing, alert shapes) | `api/test/makeRemediation.test.js` | — |
| Route mount | `api/server.js` → `POST /api/webhooks/make-remediation` | — |

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

### Not yet built here (by design)

- **Tier 1 batched Slack digest** (FR-8): `buildTier1Digest()` exists in the lib; wiring it to
  a 30-min sweep belongs on the existing scheduler/cron and is deferred.
- **Tier 1 active remap / contact search**: depends on the `cli_framework` field-equivalence
  map — repo-side action is dead-letter with a suggested action.
- **Vendor token-refresh execution** (FR-5): the circuit breaker + Slack are here; the actual
  OAuth refresh call is executed by n8n per vendor.
- **Dead-letter 30-day retention sweep** (FR-4): table is append-only; the cleanup job is TODO.

---

## Porting to cli_framework

When `cli_framework` is in scope:

1. **`lib/makeRemediation.js` ports verbatim** — it is pure and dependency-free (only Node
   `crypto`). It is the single source of truth for the taxonomy and is the natural Layer B core.
2. The route's DB helpers assume a `pg`-compatible `query()` (this repo's `db.js`). In
   `cli_framework` (Python), reimplement intake/persistence against its DB layer but keep the
   classifier semantics identical — the unit tests double as the conformance spec.
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
