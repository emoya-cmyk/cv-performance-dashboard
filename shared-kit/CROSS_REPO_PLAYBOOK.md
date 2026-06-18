# Cross-Repo Playbook — roll the shared kit into the other repos

Step-by-step execution guide for a Claude Code session **whose scope includes all
the repos** (this one — `cv-performance-dashboard` — only has scope for itself, so
the actual pushes happen from the widened session). Everything referenced lives in
`cv-performance-dashboard/shared-kit/`.

> ## Status — 2026-06-16: rollout substantially COMPLETE
> The base kit (CI workflow + `.claude/` SessionStart config + `CLAUDE.md`) is
> **already adopted** in all four active repos — `agency-performance-dashboard`
> (PR #1), `performance-dashboard` (PR #2), `cli_framework`, and
> `cv-performance-dashboard` (source). Verified: each has `CLAUDE.md`,
> `.github/workflows/ci.yml`, and `.claude/session-start.sh`.
> **`dashboard-core` is now consumed (vendored) by agency, performance, and cv**
> for the auth/security module, and **`cli_framework` has adopted `memory-os-py`**
> (vendored, tenant-scoped).
> **The only outstanding rollout step is Step 0 — the `emoya-cmyk/.github`
> reusable-workflow repo** (each repo currently *inlines* the equivalent CI, which
> works; the reusable-caller form is an optimization). Creating that org repo is
> outside a 5-repo session's scope — it needs the account owner or a widened scope.
> `integrations-performance-dashboard-app` is intentionally left alone (being retired).

## Decisions baked in
- **Keep every dashboard active** — standardize via the kit, do **not** archive.
- **Leave `integrations-performance-dashboard-app` (the integration hub) alone** — no changes.
- Canonical / kit source of truth = **`cv-performance-dashboard`**.

## Target matrix
| Repo | Lang | CI workflow | `.claude/` config | memory-os | dashboard-core |
|------|:----:|:-----------:|:-----------------:|:---------:|:--------------:|
| cv-performance-dashboard | JS | ✅ done (inlined) | ✅ done | source of kit | ✅ consumes (vendored) |
| agency-performance-dashboard | JS | ✅ done (inlined, PR #1) | ✅ done | n/a yet | ✅ consumes (vendored) |
| performance-dashboard | JS | ✅ done (inlined, PR #2) | ✅ done | n/a yet | ✅ consumes (vendored) |
| cli_framework | Python | keep own CI ✅ | ✅ done | ✅ `memory-os-py` adopted (vendored) | n/a (Python) |
| mlb_v159 | Python | keep own CI | ⏳ apply (pip/poetry hook) | ⏳ `memory-os-py` if wanted | n/a (Python) |
| integrations-performance-dashboard-app | — | ❌ leave alone (retiring) | ❌ | ❌ | ❌ |

> Inlined CI = each repo carries the kit's CI logic directly in its own
> `.github/workflows/ci.yml` (working today) rather than calling the reusable
> `node-ci.yml`; switching to the reusable caller is Step 0 below. `mlb_v159` is
> outside the current session scope and unverified here.

---

> **`shared-kit/dashboard-core/`** — the publishable `@emoya-cmyk/dashboard-core`
> package, **security module first** (the auth/authz + security layer extracted
> from agency, as DI factories; engine/connectors/semantic still to follow).
> **Now CONSUMED (vendored into `api/vendor/dashboard-core/`) by agency, performance,
> and cv** — a pure dedup with zero behavior change, each guarded by the copied
> tests. Consumption today is **vendored** (no registry/deploy-auth change);
> switching to a real dep (git-URL/file or GitHub Packages — see Step 3) is a later
> option once registry auth is set up org-wide.

## Step 0 — one-time: the shared-workflows repo
`emoya-cmyk` is a user account, so the shared-workflows repo is named `.github`:
1. Create **`emoya-cmyk/.github`** (public — so private repos can reference its workflows).
2. Add `shared-kit/.github/workflows/node-ci.yml` → `.github/workflows/node-ci.yml` in that repo.

## Step 1 — per JS dashboard (agency-performance-dashboard, performance-dashboard)
For each repo, on a feature branch:
1. **CI** — copy `shared-kit/.github/workflows/ci-caller-example.yml` → `.github/workflows/ci.yml`; set `test-dir`/`build-dir` to the repo's layout (likely `api` + `.`); delete the old inline CI.
2. **Claude config** —
   - `shared-kit/claude/session-start.sh` → `.claude/session-start.sh` (`chmod +x`)
   - `shared-kit/claude/settings.json` → `.claude/settings.json` (trim the allow-list)
   - `shared-kit/claude/CLAUDE.template.md` → `CLAUDE.md`, filled in
3. **memory-os (only if the repo has an LLM/agent surface)** — apply
   `shared-kit/memory-os/schema.{sql,sqlite.sql}`, then `npm install @emoya-cmyk/memory-os`
   (after Step 3) and `createMemory({ query })`.
4. Open a **draft PR**, confirm CI green, merge.

## Step 2 — per Python repo (cli_framework, mlb_v159)
1. **Claude config** — copy `session-start.sh` (change the install line from `npm ci`
   to `pip install -r requirements.txt` / `poetry install`), `settings.json` (swap the
   permission allow-list for the repo's Python commands), and a filled `CLAUDE.md`.
2. **memory-os-py (optional)** — copy `shared-kit/memory-os-py/` in (or `pip install`
   from a git URL), apply the schema, wrap the DB driver as the `query(sql, params)` seam
   (see `memory-os-py/test_smoke.py`), `Memory(query)`.
3. Keep each repo's existing Python CI (the reusable workflow is Node-only).

## Step 3 — publish memory-os (only if a consumer wants it)
Either:
- **Simplest:** create `emoya-cmyk/memory-os` (JS) and/or `emoya-cmyk/memory-os-py` from
  the `shared-kit/` folders, and `npm install`/`pip install` via git URL; **or**
- **Packages:** `npm publish` to GitHub Packages (`@emoya-cmyk:registry=https://npm.pkg.github.com`
  in `.npmrc` + a `packages:write` token).

## Step 4 — verify
Each touched repo: PR CI green; for memory-os adopters, run the package's smoke test
(`memory-os-py/test_smoke.py`) / port the JS memory tests.

## What NOT to do
- Do **not** modify `integrations-performance-dashboard-app`.
- Do **not** archive any dashboard — all stay active.
- Do **not** add the Node CI workflow to the Python repos.

> When running from the widened session, do each repo as its own draft PR (gates green
> before merge), exactly like the 14 PRs that built this in `cv-performance-dashboard`.

---

## Vendored dashboard-core: drift gate

`dashboard-core` is **vendored** (copied), not a registry dependency — so a copy
can silently fall behind canonical. That happened: `scopeClientQuery` gained a
`clamp` mode in canonical (cv `33a2080`) but the vendored `auth.js` in **every**
repo stayed a feature behind, undetected.

Each consumer now ships a **drift lock** + a test that fails CI on divergence:

- `api/vendor/dashboard-core/dashboard-core.lock.json` — pins the sha256 of every
  vendored `lib/*.js` to its canonical content at sync time (`synced_from_commit`).
- `api/test/vendorDashboardCoreDrift.test.js` — runs in the normal `node --test`
  suite (no new workflow); fails if a vendored file is edited, truncated, or stale
  vs the lock, or if a `lib/*.js` exists that the lock doesn't track.

### Re-sync procedure (canonical → consumers)

1. Edit only canonical: `cv-performance-dashboard/shared-kit/dashboard-core`.
2. Copy the changed `lib/*.js` into each consumer's `api/vendor/dashboard-core/lib`
   (a consumer may vendor a **subset** — only sync the files it actually carries).
3. Regenerate that consumer's `dashboard-core.lock.json` (hash its vendored
   `lib/*.js`) and bump `synced_from_commit` + the PROVENANCE stamp.
4. The drift test goes green; commit the re-sync.

> The gate is per-consumer and self-contained: it proves the vendored copy is an
> unmodified snapshot of a known canonical commit. It does **not** auto-detect
> "canonical advanced" — that remains the deliberate re-sync step above.

---

## Dev-time harness (the .claude/ floor)

The agent that builds/operates these repos runs inside a harness; a sharp harness
is what keeps an automated loop from producing slop. Canonical pieces live in
`shared-kit/claude/`; see `HARNESS_CHARTER.md` for the two-floor model (dev-time
vs run-time) and why they must stay distinct.

Pieces (beyond CLAUDE.md + session-start):
- `claude/hooks/block-dangerous.sh` — PreToolUse safety gate (exit 2 blocks
  force-push, push to main/master, broad `rm -rf`, secret/credential access).
  Deterministic — the model can't talk past it.
- `claude/agents/reviewer.md` — fresh-context reviewer subagent (writer ≠ checker):
  correctness first, then the family invariants (tenant isolation, grounded
  numbers, register-gating, fail-closed).
- `claude/agent-memory/STATE.template.md` — compounding state file: write before
  walking away, read at the start, distil general lessons into the kit.
- `claude/settings.json` — adds a `PreToolUse` wiring + `permissions.deny` safety
  floor alongside the existing SessionStart + allow-list.

### Adoption (deliberate, per repo)
Activating hooks/permissions is a **human security decision** — assistants ship
templates, not active hooks. To adopt in a repo:
1. Copy `claude/hooks/block-dangerous.sh` → `.claude/hooks/` (`chmod +x`).
2. Copy `claude/agents/reviewer.md` → `.claude/agents/` (safe; non-executing).
3. Copy `claude/agent-memory/STATE.template.md` → `.claude/agent-memory/STATE.md`
   and seed it.
4. Copy `.claude/settings.json.example` → `.claude/settings.json` to wire the
   SessionStart + PreToolUse hooks and the allow/deny lists. Trim the allow-list.
