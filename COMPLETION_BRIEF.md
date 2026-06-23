# Completion Brief — Correctness Loop Go-Live + Security Close-Out

**Date:** 2026-06-22  
**Status:** Foundation merged to `main`. Three operator items + one agent phase remaining.

## Where We Are

Framework foundation is merged across the family:
- Spec A write-verification primitive + UI
- Spec B registers
- Hub-convergence Phase 0/1
- Dev-time harness
- cli_framework go-live kit

Codebase verified secret-clean. What remains requires operator access and a repo-scope grant.

**End state:** cli_framework posts write read-backs → Write correctness tile fills per `(tenant, endpoint)` → autonomy/Wilson tier becomes earnable; exposed token rotated; push protection on.

---

## Item 1 — Security Close-Out (operator, ~5 min)

1. **Rotate the PIT token:** GHL → Settings → API → Private Integrations → revoke the exposed token → Create New Integration → copy it → paste into the dashboard Connections page for that client (stored AES-256 encrypted) → confirm a sync runs.
2. **Enable push protection:** GitHub → org `emoya-cmyk` → Settings → Code security and analysis → turn on **Secret scanning** + **Push protection** (org-level covers all repos).

---

## Item 2 — Arm the Prod Endpoints (operator, ~5 min)

On the prod host (Vercel/Render env for the dashboard API), set:

| Env var | Purpose |
|---|---|
| `MAKE_WEBHOOK_SECRET` | Gates `POST /api/webhooks/write-verification` (fail-closed: returns 503 until set). Share the same value with cli_framework. |
| `INTEGRATION_HEALTH_SECRET` | Gates the integration-health bridge. |

Confirm `main` auto-deployed after the merges; note the prod `BASE_URL`.

---

## Item 3 — Light the Correctness Loop (agent, cli_framework-scoped session)

**Scope:** add `emoya-cmyk/cli_framework` + `emoya-cmyk/cv-performance-dashboard` to a session.

**Read first** (all in cv `main`):
- `CLI_FRAMEWORK_GOLIVE_BRIEF.md`
- `WRITE_VERIFICATION_CONTRACT.md`
- `CLI_FRAMEWORK_AUDIT.md`
- `scripts/verify-write-verification.sh`
- `scripts/smoke-write-verification.mjs`

**Execute in order — do not skip the gate:**

### Phase A — Audit cli_framework (`CLI_FRAMEWORK_AUDIT.md`)

- Test suite + coverage gate exists
- Equivalence map is versioned/tested
- Canonical-identity resolution + fallback order correct
- Vault creds per-tenant isolated, no secrets in logs

> If there's no test discipline, fix that first before proceeding.

### Phase B — Implement the contract (`WRITE_VERIFICATION_CONTRACT.md`)

After every vendor write, re-read by canonical id and `POST /api/webhooks/write-verification` with `x-make-signature`. Hold the five rules:

1. True read-back (never an echo of intended value)
2. `null` on consistency lag → `PERSISTED_UNVERIFIED`
3. Normalize one side only
4. Retry/dead-letter the POST
5. Send the secret

AccuLynx (GET-only) reports the operator's manual change the same way.

### Phase C — Verify live

```bash
BASE_URL=… MAKE_WEBHOOK_SECRET=… JWT_SECRET=… ./scripts/verify-write-verification.sh
```

Watch the Write correctness tile fill across ≥2 tenants.

---

## Item 4 — Wilson Gate (deferred — do NOT do early)

Only once real `VERIFIED_CORRECT` samples accumulate per `(tenant, endpoint)`: promote the deferred `DECISION_REGISTER.md` candidate — wire Tier 0→1→2 promotion on the Wilson lower bound. Add a register entry first.

---

## Guardrails

| Rule | Detail |
|---|---|
| Fail closed | Missing read-back = `PERSISTED_UNVERIFIED`, not assumed correct |
| Earned/scoped | Promote per `(tenant, endpoint)`, never globally |
| Writer ≠ checker | Read-back from the vendor, not the payload |
| Irreversible → human | Identity / verification-schema / promotion-path → register + review |

---

## Definition of Done

- [ ] cli_framework green test suite + coverage gate in CI
- [ ] `verify-write-verification.sh` passes against prod
- [ ] Real correctness rows in `GET /api/make-remediation/correctness` across >1 tenant
- [ ] Token rotated, push protection on
- [ ] Wilson gate still unwired (correct, not incomplete)
