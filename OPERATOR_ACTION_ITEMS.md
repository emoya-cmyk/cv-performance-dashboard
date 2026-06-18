# Operator Action Items — go-live checklist (for 2026-06-22)

Everything codeable across the five `emoya-cmyk` repos is **built, tested, merged, and
inert**. What remains needs an operator at a computer with credentials / account
access. This is the consolidated checklist; each item links to the detailed runbook
that already lives in-repo.

> Nothing here runs on its own. Every item below is gated off until you turn it on,
> and each has a documented rollback. None of it writes to a vendor system without
> your explicit action (the Layer C operator-gated invariant holds throughout).

Order is independent — do them in any order. Rough time estimates are for a focused pass.

---

## 1. Activate integration-health push + operator-action bridge  ·  ~20 min
**Repos:** `cli_framework` (push/pull) ↔ `agency-performance-dashboard` (tile + endpoints)
**Runbook:** `cli_framework/INTEGRATION_HEALTH_ACTIVATION.md`

The cli→dashboard health push and the bidirectional safe-op bridge are fully built but
make **no** network call until two env vars are set and two commands are scheduled.

- [ ] Generate one shared secret: `openssl rand -hex 32`
- [ ] **Agency dashboard host env** (Render/Vercel): set `INTEGRATION_HEALTH_SECRET` to that value (ingest/bridge routes fail closed with 503 until set).
- [ ] **cli host/cron env:** set `INTEGRATION_HEALTH_URL` (`https://<agency-host>/api/integration-health`) and the **same** `INTEGRATION_HEALTH_SECRET`.
- [ ] Schedule the wrapper `cli_framework/scripts/integration_health_cron.sh.example` (copy → fill env → `chmod +x`); e.g. push every 15 min, pull every 5 min.
- [ ] Verify: `python3 integration_health_cli.py export --push` → `"pushed": true`; the **Integration Health** tile shows every tenant. Click an action in the tile, then `python3 integration_health_cli.py bridge-pull` → request reports `done`.
- [ ] Sanity: unset the env vars, re-run either command → prints `not configured`, exits non-zero, **no** network call.

**Safe because:** the only outbound call is to *your own* agency dashboard; the bridge runs only the four allow-listed safe ops (re-audit, clear breaker, rebuild index, export queue) — never a vendor write.

---

## 2. Verify + enable HCP write tools  ·  ~1–2 hrs (needs HCP staging tenant)
**Repo:** `cli_framework`
**Runbook:** `cli_framework/HCP_WRITE_VERIFICATION.md`

The HouseCall Pro **write** MCP tools are built but ship gated off (`HCP_WRITES_ENABLED`
unset → not registered). Read-only HCP tools are unaffected.

- [ ] Get HCP API docs access (Stoplight). For each write tool, confirm endpoint/method, request body, success shape, rate-limit/idempotency still match the live API.
- [ ] Use a **staging/sandbox** HCP tenant (never a live production account for first run); confirm creds resolve via `vault.py`.
- [ ] `export HCP_WRITES_ENABLED=1` then run the gated harness: `python3 scripts/verify_hcp_writes.py --client <STAGING_CLIENT_ID>` — round-trip each tool (create → read back → assert → clean up). Fill in the status-log table in the runbook.
- [ ] Destructive tools (`hcp_delete_job_note`) only against records the run itself created.
- [ ] **Promote** only after all pass: set `HCP_WRITES_ENABLED=1` in the prod MCP env for the intended client(s). **Rollback:** unset it and restart the MCP server.

**Safe because:** writes stay unregistered until verified on staging; promotion is a deliberate per-environment flag.

---

## 3. Rule-promotion go-live (Make.com remediation)  ·  ~15 min review
**Repo:** `cli_framework`
**Runbook:** `cli_framework/MAKE_REMEDIATION.md` → "Go-live runbook" section

Activating a staged promotion rule is a human decision (Gate 2) and stays one — there is
no auto-promote. The new read-only preview makes it a confident decision.

- [ ] Review candidates (reads local SQLite only, writes nothing):
      `python3 make_remediation_cli.py promotion-report`
      — `confirm_candidates` = staged rules that *would* activate; `demote_risk` = active rules already in auto-demote territory.
- [ ] For each rule you trust (underlying knowledge `approved`; Wilson lower bound comfortably above the 0.5 demote bar once it has fired):
      `python3 make_remediation_cli.py rules --status staged`  (confirm the id)
      `python3 make_remediation_cli.py confirm-rule --id <rule_id>`  (Gate 2 — the only thing that flips staged → active)
- [ ] Kill switch if a rule looks wrong: `python3 make_remediation_cli.py reject-rule --id <rule_id>`

**Safe because:** `promotion-report` cannot activate anything; `confirm-rule` is never invoked automatically; dead-letter remains the fallback for anything not lifted by an active rule.

---

## 4. Base44 app teardown  ·  ~30–45 min (needs Base44 account access)
**Repo:** `integrations-performance-dashboard-app`
**Runbook:** `integrations-performance-dashboard-app/BASE44_RETIREMENT_PLAN.md` (merged §6 checklist)

The app is ~95–100% redundant with the dashboard family and the retirement is validated;
the irreversible/external steps gate on your Base44 access.

- [ ] ⛔ **Export** all 10 cloud entities' data from Base44 (CSV/JSON) — irreversible if skipped; this is the recovery artifact.
- [ ] ⛔ **Confirm/repoint the GHL webhook**: if GHL points at the Base44 function, repoint to `https://<dashboard-host>/api/webhooks/ghl` and set `GHL_WEBHOOK_SECRET`; verify a GHL event lands in `weekly_reports` before decommissioning.
- [ ] ⛔ **Confirm zero active client usage** of the Base44 app's view.
- [ ] Migrate any wanted `ApiKey`/`Client`/`Campaign` rows into `client_connections`/`clients`/`campaigns` (§3 mapping; resolve the cardinality + custom-platform nuances).
- [ ] Only after the above: archive the Base44 app, then remove the SDK/`base44/` surface or archive the repo (§6 step 6). Steps 1–5 are reversible; the archive is the point of no return.

---

## 5. Shared-package publish + org reusable-CI repo  ·  ~30 min (optional infra)
**Repo:** `cv-performance-dashboard` (`shared-kit/`)
**Runbooks:** `shared-kit/PACKAGES.md`, `shared-kit/CROSS_REPO_PLAYBOOK.md` (Step 0)

Optional end-state only — vendoring works today with zero registry auth. Do this when
real semver / one source of truth is worth a private-registry token in every deploy env.

- [ ] **Publish:** Actions tab → "Publish shared packages" (`.github/workflows/publish-shared-packages.yml`) → tick `dry_run` first to preview, then run for `dashboard-core` / `memory-os` / `both`. (Bump each package `version` before re-publishing.)
- [ ] **Consume:** add `.npmrc` from `shared-kit/.npmrc.example`, `npm install @emoya-cmyk/...`, swap one repo's `require('../vendor/...')` → the package, delete the vendored copy (leak-proof/auth tests are the gate). Deploy envs need `GITHUB_TOKEN`/PAT with `read:packages`.
- [ ] **Org CI repo (Step 0):** create **`emoya-cmyk/.github`** (public), copy `shared-kit/.github/workflows/node-ci.yml` into it, then replace each repo's inlined `ci.yml` with the one-line caller (`ci-caller-example.yml`). Until then every repo inlines equivalent CI (works fine).

---

## Status snapshot (build side — all DONE)
- ✅ Engine extraction collapse (9 pure modules deduped cv↔agency)
- ✅ Base44 retirement plan merged (teardown gated above)
- ✅ Optional follow-ups: env-gated Voyage embedder, stale ~$5.6M `weekly_reports` cleanup, drill-down + linear reorder
- ✅ Phase 3 complete: linear reorder, click-to-drill-down, free-form 2-D grid, in-app widget builder
- ✅ Rule-promotion read-only `promotion-report` preview + runbook

No PRs open, no agents running. The five items above are the entire remaining surface,
and all of it is operator-gated by design.
