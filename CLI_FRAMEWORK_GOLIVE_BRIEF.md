# Brief — Audit `cli_framework` & light up the write-verification correctness loop

Self-contained kickoff for a session scoped to `cli_framework`. Pairs with
`CLI_FRAMEWORK_AUDIT.md` (the checklist), `WRITE_VERIFICATION_CONTRACT.md` (the
contract), and `HARNESS_CHARTER.md` (the run-time guardrail model this feeds).

**Goal (one line):** Bring `cli_framework` to the dashboard family's engineering
bar, then wire it to report write read-backs so the correctness loop goes from
*built* to *live* — without rushing past the guardrails.

## Why this is the keystone
The dashboards are well-tested (2383 passing in cv) and carry the full
write-verification primitive (ledger, ingest endpoint, operator tile, drift gate).
But the loop is **dark**: it only produces signal once `cli_framework` — which
performs the actual vendor writes (AccuLynx et al., via the vault) — re-reads each
write and POSTs the result. `cli_framework` is also currently **unaudited from the
dashboard side**, so it's the one load-bearing component held to no visible
standard. The Wilson promotion gate (autonomy) is blocked on this.

## Repo scope to request
- `emoya-cmyk/cli_framework` (the target — must be added to scope)
- `emoya-cmyk/cv-performance-dashboard` (the hub: endpoint, contract, checklist, verifier)

## Prerequisites
1. **PR #50 merged + deployed** (branch `claude/verification-correctness-register-n32sz5`)
   so `POST /api/webhooks/write-verification` exists live.
2. **`MAKE_WEBHOOK_SECRET`** set on the dashboard host and shared with `cli_framework`.
3. PIT token **rotated** + **GitHub push protection enabled** (`SECURITY.md`).

## Read first (all in cv)
`WRITE_VERIFICATION_CONTRACT.md` · `CLI_FRAMEWORK_AUDIT.md` ·
`scripts/smoke-write-verification.mjs` (self-contained proof, 13/13) ·
`scripts/verify-write-verification.sh` (live check) · `HARNESS_CHARTER.md`.

## Tasks (sequenced — do not skip the gate)

**Phase A — Audit `cli_framework` (gate before wiring).** Work `CLI_FRAMEWORK_AUDIT.md`
top-down. Non-negotiables: (1) a test suite + coverage gate exists at all;
(2) the equivalence map is versioned/tested; (3) canonical-identity resolution +
fallback order is correct; (4) vault creds are per-tenant isolated, no secrets in
logs. **If there's no test discipline, fix that first** — wiring an unaudited
keystone into the correctness loop just launders mediocrity.

**Phase B — Implement the contract.** After every vendor write, re-read by
canonical identity and POST per `WRITE_VERIFICATION_CONTRACT.md`. Hold the five
rules hard: **true read-back (never an echo of `intended`); `null` on consistency
lag → `PERSISTED_UNVERIFIED`; normalize one side only; retry/dead-letter the POST;
send `x-make-signature`.** AccuLynx (GET-only) reports the operator's manual change
the same way.

**Phase C — Verify live.** `BASE_URL=… MAKE_WEBHOOK_SECRET=… JWT_SECRET=…
./scripts/verify-write-verification.sh`, then watch the **Write correctness** tile
fill per `(tenant, endpoint)`.

**Phase D — (separate, later) Wilson gate.** Only once **real `VERIFIED_CORRECT`
samples accumulate** per `(tenant, endpoint)`, promote the deferred
`DECISION_REGISTER.md` candidate: wire promotion Tier 0→1→2 on the Wilson lower
bound. Add a register entry first.

## Definition of done
- `cli_framework` has a green test suite + coverage gate in CI (parity with the dashboards).
- `verify-write-verification.sh` passes against the live deployment.
- Real correctness rows appear in `GET /api/make-remediation/correctness` and the
  tile, across more than one tenant.
- The audit checklist is fully walked; findings recorded (a `cli_framework`
  decision register if it lacks one).
- The Wilson gate remains **unwired** until samples justify it (correct, not incomplete).

## Guardrails to hold (don't let "live" become "automate everything")
- **Fail closed.** A missing read-back is `PERSISTED_UNVERIFIED`, not assumed-correct.
- **Earned, scoped.** Promotion is per `(tenant, endpoint)` on evidence — never global.
- **Writer ≠ checker.** The read-back comes from the vendor, not the writer's payload.
- **Irreversible → human.** Identity keying, the verification schema, the
  promotion read path → register entry + review first.

## Out of scope
The engine (`mlb_v159`), the cv↔agency consolidation cutover (Option A, separately
gated), and the token rotation itself (operator action).
