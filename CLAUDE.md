# Project Guidance for Claude — cv-performance-dashboard

Onboarding for an AI assistant (and humans) working in this repo. This repo is
the **canonical source of the shared kit** for the `emoya-cmyk`
performance-dashboard family: the standardization other repos adopt lives here
in `shared-kit/`.

---

## 1. What this is
A client performance dashboard — a Vite/React frontend over an Express (Node)
API that aggregates and reports performance data, with an LLM-backed "ask"/brief
surface. Also home to `shared-kit/` (CI workflow, Claude config, memory-os),
which the sibling repos standardize on.

## 2. Architecture
```
Vite + React (root: index.html, src/)      Express API (api/)
shared-kit/  — the reusable kit rolled into the other repos
```
- `src/` — frontend app (built with Vite; Tailwind via `tailwind.config.js`)
- `api/` — Node/Express backend (`server.js`) + data layer (`db.js` Postgres,
  `db-sqlite.js`), migrations, and the AI/ask routes
- `shared-kit/` — source of truth for the cross-repo rollout
  (`.github/workflows/node-ci.yml` reusable CI, `claude/` config, `memory-os{,-py}`).
  See `shared-kit/CROSS_REPO_PLAYBOOK.md`.

## 3. Commands
```bash
npm ci --include=dev                 # install (root) — include devDeps for the build
( cd api && npm ci --include=dev )   # install api deps (api/.npmrc sets production=true)
( cd api && node --test )            # run API tests
npx vite build                       # build the frontend
npm run lint                         # eslint src
```
> `api/.npmrc` sets `production=true` for lean prod deploys, so install api deps
> with `--include=dev` (CI and the SessionStart hook both do this) or the test
> driver / build tools go missing.

## 4. Conventions & invariants (don't break these)
- Multi-tenant: keep per-tenant isolation intact; add a leak-proof test for any
  new tenant-scoped surface.
- Grounded output: every figure on the dashboard should trace to a source of truth.
- **Kit is canonical here**: when you change `shared-kit/`, remember the other
  repos consume it — keep it generic and update `CROSS_REPO_PLAYBOOK.md`.
- LLM calls are env-gated (`ANTHROPIC_API_KEY`); keep them behind a budget/rate guard.
- Make the smallest change that solves the task; match surrounding style.
- Keep the test suite green and the build clean; add tests for new behavior.

## 5. Key environment variables
| Var | Purpose |
|-----|---------|
| `JWT_SECRET` | API auth signing secret (CI uses a throwaway value). |
| `ANTHROPIC_API_KEY` | LLM features (ask/brief); env-gated, optional. |
| `AI_MODEL` | Override the LLM model used by the ask/brief surface. |
| `DATABASE_URL` | Postgres connection (prod data layer). |
| `SQLITE_PATH` | SQLite path (local/dev + tests via `db-sqlite.js`). |
| `CRON_SECRET` | Shared secret guarding the scheduled (watchdog/sync) routes. |
| `EMBEDDINGS_PROVIDER` | Memory OS semantic-recall embedder: `local` (default, free deterministic) or `voyage`. |
| `VOYAGE_API_KEY` | Voyage AI key; required to activate the `voyage` embeddings provider (Anthropic has no embeddings endpoint). |
| `EMBEDDINGS_MODEL` | Override the Voyage embeddings model (default `voyage-3.5-lite`). Switching the provider/model requires re-embedding any stored vectors. |

## 6. Where state lives
See `HANDOFF.md`, `GO_LIVE.md`, and `TRANSFORMATION_PLAN.md` for the roadmap /
source-of-truth notes; `MEMORY_OS_PRD.md` and `MAKE_REMEDIATION_PRD.md` cover
those subsystems.

## 7. Irreversible decisions
`DECISION_REGISTER.md` is the ADR-style record of architectural commitments that
can't be cheaply undone (vendor constraints, identity keying, the verification
schema). Before any commit touching **canonical identity**, the **verification
schema**, or the **promotion-tier read path**, add a candidate entry there first.
