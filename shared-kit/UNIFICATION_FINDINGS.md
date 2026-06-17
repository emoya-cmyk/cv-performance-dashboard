# Unification — Verification Findings & Decisions

**Date:** 2026-06-17 · **Branch:** `claude/unify-emoya-cmyk-family-euf1g2`
**Scope:** `cv-performance-dashboard` (canonical kit), `agency-performance-dashboard`,
`performance-dashboard`, `cli_framework`. (`mlb_v159` deliberately excluded;
`integrations-performance-dashboard-app` retiring — left alone.)

This records the `§3 "verify first"` pass from the unification execution brief and
the `§7` decisions, so later work builds on ground truth rather than the brief's
pre-inspection claims. **Where reality contradicted the brief, reality wins and is
noted below.**

---

## §3 Verification — what's actually true

### 3.1 dashboard-core vendoring — DRIFTED (now fixed in this branch)
Real `diff -rq` against canonical `shared-kit/dashboard-core` (v0.4.0):

| Consumer | Was | Real drift found | Action |
|----------|-----|------------------|--------|
| `cv/api/vendor` | 0.2.0 | `lib/auth.js`, `test/authz.test.js`, `package.json` only (all engine modules already present) | re-synced to 0.4.0 |
| `agency/api/vendor` | 0.1.0 | auth/security subset only; **missing all 9 engine modules**; `auth.js`/`index.js`/`README`/`package.json` differ | re-synced to 0.4.0 |
| `performance/api/vendor` | 0.1.0 | same as agency | re-synced to 0.4.0 |

> **Correction to an earlier automated pass:** it reported cv was "missing 9 analysis
> modules." It was not — cv had all 15 lib files; only `auth.js`/`authz.test.js`/version
> differed. Always re-diff.

**Key safety fact:** the `auth.js` change is a **backward-compatible superset**.
`scopeClientQuery(paramName, { mode = 'reject' })` defaults to the prior behavior;
it only *adds* an opt-in `clamp` mode (the variant `performance-dashboard` kept
locally). Re-sync cannot regress reject-mode callers (cv, agency) and does not
touch performance's local clamp path.

**Re-sync result (gate = each repo's full `api` `node --test`):**
- cv: 2334 → **2342** pass (+8 clamp tests), 0 fail
- agency: 2098 → **2231** pass (+133 engine-module tests), 0 fail
- performance: 58 → **191** pass (+133 engine-module tests), 0 fail

All three vendor dirs are now byte-identical to canonical except their own
`PROVENANCE.md` (intentional) and `package-lock.json` (excluded by convention).

### 3.2 Kit adoption — CONFIRMED, no drift
`CLAUDE.md` (from template), inlined `.github/workflows/ci.yml`, and
`.claude/session-start.sh` are present and matching in agency, performance, and
cli_framework (Python variant). cli_framework correctly keeps its own Python CI.
SessionStart hooks exist as `*.example` templates; none are wired into an active
`settings.json` (deliberate — human opt-in).

### 3.3 memory-os — IN SYNC (no engine drift)
`cli_framework/enhancements/vendor/memory_os` vs canonical `shared-kit/memory-os-py`:
`memory_os.py`, `schema.sql`, `schema.sqlite.sql` are **byte-identical** (vendored @
commit `dba13d7`, "Phase 8 semantic recall"). Differences are only the intentional
`__init__.py` adapter and the omitted `pyproject.toml`/`test_smoke.py`. No action.

### 3.4 Make remediation Layer B — DONE, ahead of the brief
cv side complete (`api/lib/makeRemediation.js`, `routes/webhooks/makeRemediation.js`,
`lib/makeRemediationSweeps.js`, migrations 031/032). The "pending port into
cli_framework" the brief flags is **already done**: `enhancements/make_remediation*.py`,
`make_remediation_cli.py`, `mcp_server/tools/make_remediation.py`, plus the Tier-1
active remap, Layer C integration, and bridge. Only remainder is external
(Make.com/n8n config), not code.

### 3.5 `emoya-cmyk/.github` org repo — UNVERIFIABLE here
Outside this session's repo scope; MCP access denied. Treated as **owner-blocked**
(matches A1's caveat). CI stays inlined until it exists.

---

## §7 Decisions (delegated to recommendations)

1. **Memory substrate (B1):** **Federated read-across + a thin shared synthesis
   store.** Keep every repo's `agent_memory` federated and tenant-scoped (raw
   memory never co-mingles); expose a read-only cross-repo recall; add one small
   family-level store holding **only grounded, synthesized insights** (the output
   of the synthesis/pattern skills, each citation traced to its source repo). Max
   Jarvis payoff, minimal blast radius, tenant isolation preserved.
2. **Packages (A2):** **Re-sync vendor now (done); defer GitHub Packages** until
   the org repo (A1) exists. The drift sat in an auth module — fixing it could not
   wait on new registry infra.
3. **mlb_v159:** **Keep fully isolated.** Its never-guess discipline + work/personal
   IP boundary outweigh marginal cross-domain signal.
4. **Org repo (A1):** **Owner-blocked.** Prepare reusable caller workflows; human
   provisions `emoya-cmyk/.github`, then wire-up is trivial.

---

## Status & next

- [x] §3 verification recorded
- [x] **A2 (partial): dashboard-core vendor re-sync** — cv, agency, performance (gated green)
- [ ] A1: org repo (owner-blocked) → then flip vendoring to `@emoya-cmyk/*` packages
- [x] **B1: federated cross-repo read-only recall** — `cli_framework/enhancements/family_memory.py`
      (`FamilyRecall`); federation, not a shared table. Gated by `tests/test_family_memory.py` (25/25).
- [x] **B2/B3: grounding inheritance + tenant-scope leak test** — cross-repo hits are claims until
      grounded against the source repo's evidence path (fails closed); leak-proof recall tested both
      directions; grounded, cited, recommend-only synthesis store
      (`cli_framework/enhancements/family_synthesis_store.py`).
- [x] **B wiring** — `cli_framework/enhancements/family_sources.py` (read-only source adapters: SQLite +
      Postgres `$N`→`%s` seam = the Python-side "JS Memory OS read shim"; structural read-only guard;
      config-driven `load_sources`, local store always included) + MCP tools
      (`mcp_server/tools/family_memory.py`, wired in `clients/loader.py`).
- [x] **C1/C2** — `cli_framework/enhancements/family_synthesis.py`: `weekly_synthesis` (grounded cross-repo
      co-occurrence) + `monthly_patterns` (≥4 independent grounded notes across ≥2 repos). Grounded-only,
      recommend-only, tenant-scoped. Operator CLI `family_cli.py`.
- [x] **D1** — `cli_framework/enhancements/family_orchestration.py`: read-only view of every scheduled
      skill across the family (dashboard crons "declared (not polled)"; local cadence enriched).
- Gates: `cli_framework/tests/test_family_{memory,sources,synthesis,orchestration}.py` = 57 assertions green.

**Remaining (owner / infra, not code):**
- A1 org repo `emoya-cmyk/.github` (owner-blocked) → then A2 flip vendoring to `@emoya-cmyk/*` packages.
- Point `FAMILY_MEMORY_SOURCES` at the dashboards' live Memory OS DBs (DSNs stay in host env).
- Optional Phase C LLM phrasing pass (env-gated) on top of the deterministic synthesis core.

**Guardrails (unchanged):** draft PRs, G1–G4 green before merge, grounded-only,
tenant isolation never weakened, no autonomous config writes (skills recommend;
humans merge), credential hygiene.
