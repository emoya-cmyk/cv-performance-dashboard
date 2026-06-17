# `emoya-cmyk/.github` bootstrap (A1 — owner action)

Ready-to-publish content for the org-level repo that hosts the reusable CI, plus
the drop-in caller that replaces each JS repo's inlined `ci.yml`. **This is
owner-gated**: creating an org repo needs account-owner permissions, which the
automation does not have — so this is staged here, not applied.

## Why this exists / what it fixes
The cross-repo playbook says "switch each JS repo's inlined CI to the reusable
caller." Verified first: the dashboards' inlined `frontend` job runs
`npm run lint` **and** `npm run test:fe` (Vitest) alongside `vite build`, but the
old reusable `node-ci.yml` only built. Switching naively would have **dropped
lint + frontend tests**. The reusable workflow has since gained
`lint-command` / `frontend-test-command` inputs, and the caller below uses them,
so the switch preserves every gate the repos run today.

## Steps (owner)
1. **Create the repo** `emoya-cmyk/.github` (Public).
2. **Publish the reusable workflow** into it at
   `.github/workflows/node-ci.yml` — copy this repo's canonical
   `shared-kit/.github/workflows/node-ci.yml` verbatim. (Callers reference it as
   `emoya-cmyk/.github/.github/workflows/node-ci.yml@main`.)
3. **Switch each JS repo** (`cv-performance-dashboard`,
   `agency-performance-dashboard`, `performance-dashboard`): replace
   `.github/workflows/ci.yml` with `caller-ci.yml` from this folder (identical
   for all three). Open as a draft PR per repo; confirm the API tests, lint,
   Vitest, and build all still run green, then merge.
4. Leave `cli_framework` alone — it keeps its own Python CI by design.

## Files here
- `caller-ci.yml` — the drop-in `.github/workflows/ci.yml` for the three JS repos.
  Preserves: API tests (`api/`), `npm run lint`, `npm run test:fe`, `vite build`.

The reusable workflow itself is **not duplicated here** — it lives canonically at
`shared-kit/.github/workflows/node-ci.yml`; publish that.
