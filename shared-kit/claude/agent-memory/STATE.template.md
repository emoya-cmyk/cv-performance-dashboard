# Agent memory — `<repo>`

The compounding state file (harness step 12): what the agent forgets between runs,
the harness remembers. **Write before walking away** (end every run by updating
this); **read at the start** (resume, don't restart); **distill** general lessons
into skills/rules so they apply to every future run.

Keep it tight — verified facts and durable lessons, not a changelog.

## Verified facts
<!-- Stop re-deriving these. State the fact + how it was verified. -->
- _(e.g. dashboard-core is VENDORED, not an npm dep — re-sync from
  shared-kit/dashboard-core; the drift gate test enforces it.)_

## Lessons learned
<!-- Durable gotchas. Distill the general ones into shared-kit skills/rules. -->
- _(e.g. better-sqlite3 native build fails in some sandboxes; rely on CI for
  sqlite-backed tests, not the local box.)_

## Open invariants to respect
<!-- The things a review must never let slip. -->
- Multi-tenant isolation; grounded numbers; smallest change; tests green.
- Irreversible commits → add a DECISION_REGISTER.md candidate first.

## Last session
<!-- One line. Resume point for the next run. -->
- _(date · what landed · what's next)_
