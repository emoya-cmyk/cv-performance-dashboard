# Shared Kit — cross-repo Claude Code config + reusable CI + memory-os

A drop-in kit to standardize **CI**, **Claude Code web/remote sessions**, and
**agent memory** across your repos. Authored here (the only repo this session can
write to); apply it to the others with the steps below.

> Why this exists: `cv-performance-dashboard`'s CI was silently red because a
> committed `.npmrc` (`production=true`) made `npm ci` skip devDependencies
> (the test driver). The fix — install with `--include=dev` — plus a few other
> conventions, are worth standardizing everywhere instead of rediscovering.

## Contents
| Path | What | Applies to |
|------|------|-----------|
| `.github/workflows/node-ci.yml` | Reusable (`workflow_call`) CI: install **with devDependencies**, test + build. | all JS repos |
| `.github/workflows/ci-caller-example.yml` | One-file CI a repo drops in to call the reusable workflow. | all JS repos |
| `claude/session-start.sh` | SessionStart hook — installs deps on session start so web sessions can run checks. | all repos |
| `claude/settings.json` | Baseline Claude Code settings (wires the hook + a safe permission allow-list). | all repos |
| `claude/CLAUDE.template.md` | Fill-in project-guidance template. | all repos |
| `memory-os/` | Decoupled `@emoya-cmyk/memory-os` package (DI db + grounding) + schema. | JS LLM/agent repos |
| `memory-os-py/` | Python port of memory-os (same contract/guarantees) + smoke test. | Python repos (cli_framework, mlb_v159) |
| `dashboard-core/` | Publishable `@emoya-cmyk/dashboard-core` — **security module first** (auth/authz, headers, rate-limit/AI-budget, password-floor/timing-equalizer/JWT-boot-guard as DI factories); engine/connectors/semantic to follow. | JS dashboard repos |

## Your repos — suggested rollout
| Repo | CI workflow | Claude config | memory-os |
|------|:-:|:-:|:-:|
| cv-performance-dashboard | ✅ (already fixed) | ✅ | source |
| agency-performance-dashboard | ✅ | ✅ | ✅ if LLM features |
| performance-dashboard | ✅ | ✅ | optional |
| integrations-performance-dashboard-app | ✅ | ✅ | optional |
| cli_framework (Python) | hook only* | ✅ | — |
| mlb_v159 (Python) | hook only* | ✅ | — |
\* The Node CI workflow is JS-only; for the Python repos keep their own CI and just adopt the Claude config (tweak `session-start.sh` to `pip install`/`poetry install`).

---

## Rollout steps

### 1. Create the org-shared workflow repo (one time)
`emoya-cmyk` is a **user account**, so the shared-workflows repo is a normal repo
named `.github`:
1. Create `emoya-cmyk/.github` (public, so private repos can reference its workflows).
2. Add `.github/workflows/node-ci.yml` from this kit (same path inside that repo).

### 2. Per JS repo — adopt CI (one file)
Copy `ci-caller-example.yml` to the repo as `.github/workflows/ci.yml`, set
`test-dir` / `build-dir` to match its layout, and delete its old inline CI. The
caller pins `@main` of the shared workflow, so future CI fixes propagate by
updating one file.

### 3. Per repo — adopt the Claude Code config
- Copy `claude/session-start.sh` → `.claude/session-start.sh` and `chmod +x`.
- Copy `claude/settings.json` → `.claude/settings.json` (trim the allow-list).
- Copy `claude/CLAUDE.template.md` → `CLAUDE.md` and fill it in.
(For the Python repos, change `session-start.sh` to install via pip/poetry.)

### 4. (LLM/agent repos) — adopt memory-os
1. Publish once: from `memory-os/`, `npm publish` to GitHub Packages
   (`@emoya-cmyk:registry=https://npm.pkg.github.com` in `.npmrc` + a `packages:write` token).
   Or, simplest: create an `emoya-cmyk/memory-os` repo from these files and
   `npm install` it via a git URL.
2. In the consumer: apply `schema.sql`/`schema.sqlite.sql`, then
   `const mem = createMemory({ query })` (see `memory-os/README.md`).

---

## Note on this session's scope
This session can only write to **cv-performance-dashboard**, so the kit is
delivered here as ready-to-copy files. To have me apply it directly to the other
repos (create `emoya-cmyk/.github`, push workflows, etc.), widen this session's
repo scope — then I can roll it out for you.
