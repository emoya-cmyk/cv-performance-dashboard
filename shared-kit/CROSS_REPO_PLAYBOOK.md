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
`emoya-cmyk` is a user account, so the shared-workflows repo is named `.github`.
**Ready-to-publish bootstrap staged in `shared-kit/org-repo-bootstrap/`** (owner-gated):
1. Create **`emoya-cmyk/.github`** (public — so private repos can reference its workflows).
2. Add `shared-kit/.github/workflows/node-ci.yml` → `.github/workflows/node-ci.yml` in that repo.

> **Verified caveat:** the JS dashboards' inlined CI runs `npm run lint` **and**
> `npm run test:fe` (Vitest) alongside the build — switching to the caller naively
> would have dropped those gates. `node-ci.yml` now takes `lint-command` /
> `frontend-test-command` inputs, and `org-repo-bootstrap/caller-ci.yml` uses them,
> so the switch preserves every gate. Use that caller (it covers cv too), not a
> minimal one.

## Step 1 — per JS dashboard (agency-performance-dashboard, performance-dashboard)
For each repo, on a feature branch:
1. **CI** — copy `shared-kit/org-repo-bootstrap/caller-ci.yml` → `.github/workflows/ci.yml` (it keeps API tests + lint + Vitest + build); delete the old inline CI.
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

**Vendor drift guard (don't trust ✅ — prove it):**
- In-repo: cv's `api/test/vendorSync.test.js` fails CI if `api/vendor/dashboard-core`
  drifts from canonical `shared-kit/dashboard-core` (the gap that let it slip to 0.2.0).
- Family-wide: `python3 shared-kit/scripts/check_vendor_drift.py` scans every consumer
  (dashboard-core in cv/agency/performance, memory-os-py in cli_framework) and exits
  non-zero on drift. Run it on a schedule (or in the org-repo CI once it exists).

## Token-compaction layer (`compaction/` + `compaction-py/`)

**Status — G1 landed (this PR), G2–G4 gated.** A lossless token-compaction layer
lives in `shared-kit/compaction/` (JS, `@emoya-cmyk/compaction`) and
`shared-kit/compaction-py/` (Python, byte-identical `enc=v1` format). It reformats
an array of near-uniform JSON objects into one schema header + delimited rows
(repeated field names named once; **every value survives** —
`expand(compact(x).text) == x`), plus a prompt-prefix cache-alignment helper. It is
**lossless-only by design** (no row-drop, no truncation, no reversible-offload) so
it stays compatible with the grounded-AI invariant. Full spec + rationale:
`compaction/README.md`. Credit: `compaction/NOTICE` (clean-room from
`chopratejas/headroom`, Apache-2.0).

- **Import (JS):** `const { compact, expand, assemblePrompt } = require('@emoya-cmyk/compaction')`.
  `compact(rows)` → `{ compacted, text, ratio, reason, … }`; `text` is always
  model-ready (block, or original JSON). Assemble prompts stable-prefix-first via
  `assemblePrompt({ stable, volatile })`.
- **Import (Python):** `from compaction import compact, expand` /
  `from cache_align import assemble_prompt`.
- **Threshold config (D-3 defaults, overridable per call):** `minRows=5`,
  `minTokens=200`, `coreFieldFraction=0.8`, `heterogeneousCoreRatio=0.6`.
- **`verify` flag (D-4, default `true` — recommended everywhere):** round-trips
  inline and **falls back to the original** on any mismatch. Keep it on; the small
  CPU cost buys the fidelity guarantee.

**Distribution — vendor now, Packages later (aligns with PACKAGES.md / D-2).**
GitHub Packages is not yet live, so consume `compaction` the same way the family
already consumes `dashboard-core` / `memory-os-py`: **vendor** the folder into the
consumer (e.g. `api/vendor/compaction/` for JS, copy `compaction-py/` for Python)
and let `scripts/check_vendor_drift.py` guard drift. If/when Packages goes live,
publish `@emoya-cmyk/compaction` and switch the import — do **not** invent a new
distribution path. **Betting repos vendor it locally and stay an island** (no
federation, no memory loop) — lossless compaction only, `verify=True`.

**Gated rollout (do NOT skip the gates):**
- **G1 (done here):** land both primitives + golden fixtures in `shared-kit`; prove
  round-trip, passthrough, and verify-fallback. → review.
- **G2 (landed — `cli_framework` PR on the token-compression branch):** compaction
  is vendored into `enhancements/vendor/compaction/` (drift-guarded above) and wired
  into the Make.com Tier 3 failure-research prompt via `enhancements/llm_compaction.py`
  — **read-side only, `verify=True`**, write/verify path untouched; single-dict
  payloads keep the exact legacy preview. Includes the §8 ~10% holdout + JSONL
  measurement hook; `scripts/measure_compaction.py` reports a MEASURED ~56% char
  reduction on representative reads (provider-token A/B pending a live run). → review.
- **G3 (cv landed — same PR #51):** compaction vendored into `api/vendor/compaction/`
  (guarded by `api/test/vendorSyncCompaction.test.js`) and wired into the "ask"
  result-narration call site (`api/lib/ask.js` `buildNarrateContent`): the tabular
  result `rows` are losslessly compacted (~32% smaller on a 20-row group_by=client
  ask). Grounding is unchanged by construction — the allow-set is computed from
  `rows`, not the prompt string, and the values round-trip exactly (full api suite
  green: 2384/2384, incl. grounding + memory). §3.2 cache alignment was already in
  place (`api/lib/anthropic.js` sends the static system prompt as the cached prefix),
  so no change there. **Fan-out to agency / performance / integrations is follow-on**
  per-repo PRs — each needs its LLM/ask surface verified first (cv is the repo with
  the ask/brief surface; the others may not have an equivalent tabular→model site).
  → review.
- **G4 (default: stop):** decide whether any specific non-write, high-volume path
  warrants opt-in lossy/CCR. Recommended default: **do not enable**; betting excluded
  regardless.

## What NOT to do
- Do **not** modify `integrations-performance-dashboard-app`.
- Do **not** archive any dashboard — all stay active.
- Do **not** add the Node CI workflow to the Python repos.

> When running from the widened session, do each repo as its own draft PR (gates green
> before merge), exactly like the 14 PRs that built this in `cv-performance-dashboard`.
