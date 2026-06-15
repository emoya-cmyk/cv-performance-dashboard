# Cross-Repo Playbook — roll the shared kit into the other repos

Step-by-step execution guide for a Claude Code session **whose scope includes all
the repos** (this one — `cv-performance-dashboard` — only has scope for itself, so
the actual pushes happen from the widened session). Everything referenced lives in
`cv-performance-dashboard/shared-kit/`.

## Decisions baked in
- **Keep every dashboard active** — standardize via the kit, do **not** archive.
- **Leave `integrations-performance-dashboard-app` (the integration hub) alone** — no changes.
- Canonical / kit source of truth = **`cv-performance-dashboard`**.

## Target matrix
| Repo | Lang | CI workflow | `.claude/` config | memory-os |
|------|:----:|:-----------:|:-----------------:|:---------:|
| cv-performance-dashboard | JS | ✅ done | ✅ | source of kit |
| agency-performance-dashboard | JS | ✅ apply | ✅ apply | ✅ JS, if it has LLM features |
| performance-dashboard | JS | ✅ apply | ✅ apply | ✅ JS, if it has LLM features |
| cli_framework | Python | keep own CI | ✅ apply (pip/poetry hook) | ✅ `memory-os-py` if wanted |
| mlb_v159 | Python | keep own CI | ✅ apply (pip/poetry hook) | ✅ `memory-os-py` if wanted |
| integrations-performance-dashboard-app | — | ❌ leave alone | ❌ | ❌ |

---

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
