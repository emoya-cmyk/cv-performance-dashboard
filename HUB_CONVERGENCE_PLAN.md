# Hub Convergence Plan — `cv` ↔ `agency`

**Status:** In progress. **Phase 0 + Phase 1 (backend) done**: the two
agency-unique features (`integrationHealth`, `remediationRequests`, the
cli_framework ↔ dashboard bridge) are up-ported into cv with their migrations
(036/037) and integration tests (full suite green). The remaining phases —
reconcile drifted libs, single-source the brain, and the register-gated
decommission — are not executed. Pairs with `DECISION_REGISTER.md` (candidate:
*consolidate cv/agency*).

> Follow-up for Phase 1: the operator-facing Integration-Health **tile** (agency
> `src/components/IntegrationHealthPanel.jsx` + its `api.js` helper + Intelligence
> wiring) is not yet ported — the backend bridge is live and tested; the UI is the
> next increment.

## 1. The problem, in evidence

`cv-performance-dashboard` and `agency-performance-dashboard` are the **same
product** (both `package.json name = "performance-dashboard"`) maintained as **two
hand-synced copies** — *not* git forks (different root commits), so there is no
merge path, only manual copying, and the copies have drifted.

Measured delta (this branch):

| Surface | Finding |
|---|---|
| `api/lib` | agency's 85 libs are **all** present in cv (102). **0 agency-only libs.** |
| Brain libs cv-only | `makeRemediation*`, all memory-os (`memory*`, `embeddings`, `memorySemantic`), `alertEngine`/`alertDelivery`, `writeVerification*`, `semrush`, `callPrep` (17 files). |
| Routes cv-only | `alerts`, `dashboards`, `events`, `makeRemediation`, `memory`, `seo`. |
| **Routes agency-only** | **`integrationHealth` (227L), `remediationRequests` (259L)** — inline logic, no lib backing, + migrations `022`, `023`. **These would be lost in a naive "ship cv."** |
| Migrations | agency is **14 behind** cv. |
| Frontend pages cv-only | `BingAds`, `CallPrep`, `Dashboards`, `Goals`, `JobManagement`, `PhoneCalls`, `SEO`. |
| Drifted shared libs | `facts.js` (25 lines), `heartbeat.js` (42), `recap.js` (9), `ai.js` (7) — functional; `authSecurity.js` (25) — **comments only, code identical** (no security divergence). |

**Read:** cv is far ahead on the brain; agency is a leaner, older copy that *also*
grew two unique features. Divergence is bidirectional and growing. Every shared
fix is paid for twice, and drift is silent (which is what the new
`dashboard-core` drift gate was added to stop — but that only covers the vendored
core, not the 85 hand-copied app libs).

## 2. Canonical choice

**`cv` is canonical.** It strictly contains agency's lib surface and is ahead on
brain, routes, migrations, and UI. Convergence direction is agency → cv.

## 3. Target model (pick one)

- **Option A — one codebase, per-agency deploy (recommended).** cv becomes *the*
  hub; "agency" becomes a **deployment** (own DB/env/branding via config), not a
  repo. Eliminates the fork tax entirely. Fits the single-agency-per-deploy model
  (`DECISION_REGISTER.md` DR-1) — that model is exactly what's currently being
  expressed (badly) as repo-per-deploy.
- **Option B — separate repos, shared brain as a package.** Keep per-agency repos
  if contractually required, but agency consumes the brain from
  `shared-kit`/`dashboard-core` (real dependency, never hand-copied). Heavier than
  A; only justified if repo-level isolation is a hard requirement.
- **Option C — status quo (rejected).** Keep hand-syncing. Guarantees continued
  drift and double-maintenance; the only "benefit" is doing nothing now.

## 4. Reconciliation required BEFORE any cutover

1. **Port agency's two unique features into cv (or the kit):** `integrationHealth`
   + `remediationRequests` routes and migrations `022`/`023`, with tests. Until
   this lands, convergence would regress agency.
2. **Reconcile the 4 functional drifted libs** (`facts`, `heartbeat`, `recap`,
   `ai`): diff-review each, keep the correct behavior (default cv), capture any
   agency-only fix worth keeping. `authSecurity.js` needs no code change (comments).
3. **Confirm migration parity / ordering** so agency data survives the cutover.

## 5. Sequenced plan (each step shippable; reversible until Phase 5)

- **Phase 0 — Freeze the fork.** All new shared work goes to cv (or the kit) only;
  stop hand-copying into agency. (Cheap, immediate, stops the bleeding.)
- **Phase 1 — Up-port agency-unique features** into cv behind flags, with tests.
- **Phase 2 — Reconcile drifted libs** to a single canonical version.
- **Phase 3 — Single-source the brain** (closes register gap #2-root): move the
  17 brain libs' stable, generic parts into `shared-kit`/`dashboard-core` so they
  are *consumed*, not copied. Extend the drift gate to cover them.
- **Phase 4 — Choose A or B** and stand up agency as a deploy of cv (A) or wire it
  to consume kit packages (B).
- **Phase 5 — Decommission** the divergent agency code; agency repo becomes
  config-only (A) or a thin consumer (B). *This is the irreversible step* — gate it
  on a verified data + feature-parity check.

## 6. Blast radius

- **Tenant isolation must hold across the cutover** — the highest risk; every
  phase keeps per-tenant scoping intact and leak-tested.
- **agency's live clients + data** must migrate without loss (Phase 5 gate).
- **The two unique features must not regress** (Phase 1 gate).
- Security parity (`authSecurity`/`dashboard-core`) is already aligned — keep it so.

## 7. Recommendation

Do **Phase 0 now** (it's free and stops drift), then **Phase 1–3** as normal
feature work, and treat **Phase 4–5 as an explicit, register-gated decision**.
Option A is the right end state unless repo-per-deploy is contractually forced.
