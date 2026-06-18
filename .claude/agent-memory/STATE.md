# Agent memory — cv-performance-dashboard

Compounding state (harness step 12). Write before walking away; read at the start;
distill general lessons into shared-kit. See `shared-kit/claude/agent-memory/STATE.template.md`.

## Verified facts
- cv is the **canonical hub**; `agency` was a strict lib-subset of cv (now also
  has cv's two unique features up-ported). `performance` is a lean reporting tier.
- `dashboard-core` is **VENDORED, not an npm dep** — edit canonical at
  `shared-kit/dashboard-core` and re-sync; `api/test/vendorSync.test.js` (cv) +
  `shared-kit/scripts/check_vendor_drift.py` (siblings) enforce byte-identity.
- API tests: `cd api && node --test` (2383 green as of 2026-06-18). DB seam: unset
  `DATABASE_URL` + set `SQLITE_PATH` → SQLite.
- `cli_framework` (external, Python/MCP, vault) is the keystone: Jarvis, AccuLynx,
  the equivalence map, the real writes. It is **load-bearing for correctness**
  (must POST read-backs to `/api/webhooks/write-verification`) and **unaudited**.

## Lessons learned
- `better-sqlite3` native build fails in some sandboxes (`gyp` ENOENT) — rely on
  CI for sqlite-backed tests, not the local box. The drift/pure tests need no sqlite.
- The four cv↔agency "drifted" libs are cv-AHEAD (memory-os, new-channels,
  alertEngine) — copying them into agency would hard-break it. No standalone
  reconciliation; folds into Phase 3 / Option A.
- Activating `.claude/settings.json` (hooks/permissions) is a deliberate human
  security step here — assistants ship templates (`.example` / shared-kit), not
  active hooks.

## Open invariants to respect
- Multi-tenant isolation (leak-proof test for any new tenant-scoped surface);
  grounded numbers; smallest change; tests green.
- Irreversible commits (identity/tenancy, verification schema, promotion read
  path, teardown) → add a `DECISION_REGISTER.md` candidate first.

## Last session
- 2026-06-18 · Shipped Spec A (write-verification) + UI, Spec B registers
  family-wide, dashboard-core drift gate, Phase 0/1 hub convergence (integration
  -health + remediation-requests up-ported), and the dev-time harness (this).
  Next: audit `cli_framework`; wire correctness → Wilson gate once samples exist.
