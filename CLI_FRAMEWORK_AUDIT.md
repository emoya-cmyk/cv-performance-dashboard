# `cli_framework` Audit Checklist — the load-bearing dependency

> Kicking this off? Start from **`CLI_FRAMEWORK_GOLIVE_BRIEF.md`** — the
> sequenced, self-contained brief (scope, prerequisites, phases, done-criteria)
> that wraps this checklist.

**Status:** Checklist, **not** a performed audit. `cli_framework` is **not in this
session's repo scope**, and `list_repos`/`add_repo` were unavailable here, so it
could not be pulled in and inspected. To actually run this, widen a future session
to include `cli_framework` (or run it there directly).

## Why this matters now

`cli_framework` (Python/MCP, vault-credentialed) is the external brain that holds
Jarvis, the AccuLynx integration, the credential vault, the ~158-entry
field-equivalence map, and **the actual remap writes**. The dashboards defend
themselves well (2369 tests in cv); the thing they *trust* is unaudited from here.

The write-verification correctness primitive (Spec A) **increased** this
dependency: the correctness loop only lights up when `cli_framework` re-reads each
write and POSTs the result to `POST /api/webhooks/write-verification`. So
`cli_framework` is now load-bearing for *correctness*, not just sensing — and a
silent gap there means the dashboards believe writes are correct when they may not
be.

## A. The correctness contract (highest priority)

- [ ] After **every** write, does it re-read the record **by canonical identity**
      (`acculynx_job_id`, then email, then phone) and POST
      `{tenant_id, endpoint, persisted, intended, read_back, canonical_id, canonical_id_kind}`?
- [ ] Is `read_back` a **true re-read from the vendor**, not an echo of the payload
      it just sent? (An echo would always report VERIFIED_CORRECT — false trust.)
- [ ] On eventual-consistency lag, does it send `read_back: null` (→
      `PERSISTED_UNVERIFIED`) rather than omitting verification entirely?
- [ ] Does it use the existing **field-equivalence map** to normalize before
      comparing — or does it leave normalization to the dashboard? (Contract must
      be explicit about which side normalizes; double- or zero-normalization both
      corrupt the verdict.)
- [ ] Is the POST **retried / dead-lettered** on failure, so correctness samples
      aren't silently lost when the dashboard is briefly unreachable?
- [ ] Does it send the `MAKE_WEBHOOK_SECRET` (`x-make-signature`) on these calls?

## B. Test coverage (the unverified surface)

- [ ] Is there a test suite at all, and a **coverage gate** in its CI?
- [ ] Are the critical paths covered: the equivalence map, canonical-identity
      resolution + fallback order, the remap writes, the read-back compare?
- [ ] Is the **equivalence map versioned and change-controlled** (158 entries is a
      lot of silent behavior)? Is each entry tested?
- [ ] Brought under the **same CI bar as the dashboards** (lint + test + coverage)?

## C. Security

- [ ] Vault credential handling: no secrets in logs, scoped access, rotation path.
- [ ] **Per-tenant isolation in the credential store** — one tenant's creds can
      never be used for another (mirror the dashboards' isolation invariant).
- [ ] Secret rotation procedure exists (see the open PIT-token item in
      `performance-dashboard` PRD §20 — rotate that regardless).

## D. Reliability & single-point-of-failure

- [ ] What happens to the dashboards if `cli_framework` is **down**? Is there
      graceful degradation, or does the autonomy loop just silently stall?
- [ ] Idempotency on remap writes (no double-writes on retry).
- [ ] Circuit-breaker / backoff parity with the dashboard's Make-remediation tiers.

## E. Observability

- [ ] Logging + alerting **on `cli_framework` itself** (error rates on remaps,
      read-back failures, vault errors) — not just on the dashboards.
- [ ] A dashboard-side view of `cli_framework` health (the new
      `GET /api/make-remediation/correctness` surfaces *outcomes*; pair it with a
      liveness/error signal from the framework).

## How to actually run this

1. Widen a session to include `cli_framework` (use `list_repos` → `add_repo` when
   those tools are available, or run the session from that repo).
2. Work top-down: **Section A first** — the correctness contract is what Spec A now
   depends on; a gap there invalidates the promotion path before it's even built.
