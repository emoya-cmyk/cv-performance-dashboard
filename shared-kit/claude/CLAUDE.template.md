# Project Guidance for Claude — <PROJECT NAME>

Onboarding for an AI assistant (and humans) working in this repo. Fill the
angle-bracket placeholders, delete what doesn't apply, and keep it short.

---

## 1. What this is
<One or two sentences: what the project does and who uses it.>

## 2. Architecture
```
<frontend stack + dir>      <backend stack + dir>
```
- `<dir>/` — <what lives here>
- `<dir>/` — <what lives here>

## 3. Commands
```bash
<install>     # e.g. npm ci --include=dev
<test>        # e.g. node --test   (from api/)
<build>       # e.g. npx vite build
<lint>        # e.g. npx eslint src
```
> If a committed `.npmrc` sets `production=true`, install with `--include=dev`
> so devDependencies (test drivers, build tools) are present.

## 4. Conventions & invariants (don't break these)
- <e.g. tenant isolation / auth boundary — add a leak-proof test for any new scoped surface>
- <e.g. grounded output only — every figure traces to a source of truth>
- <e.g. migrations come in pairs / both gates green per commit>
- Make the smallest change that solves the task; match surrounding style.
- Keep the test suite green and the build clean; add tests for new behavior.

## 5. Key environment variables
| Var | Purpose |
|-----|---------|
| `<NAME>` | <purpose> |

## 6. Where state lives
<Point to the handoff/roadmap docs that are the source of truth, if any.>
