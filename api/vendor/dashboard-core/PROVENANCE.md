# Provenance

Vendored from `cv-performance-dashboard/shared-kit/dashboard-core` (canonical).
**Re-sync from there; do not edit in place.**

- **Source:** `shared-kit/dashboard-core` @ `@emoya-cmyk/dashboard-core` v0.4.0
- **Source commit (cv):** `b6aa22e57c30fe00badb0c96f6fbfe9e446e15db`
- **Synced:** 2026-06-17 (Phase A2 — vendor drift re-sync; consumers were behind at 0.1.0/0.2.0)

This copy is byte-identical to canonical (auth/authz + security layer **and** the
engine layer: baselines, forecast, attribution, pacing, precision, correlate,
contribution, ratioAttribution, metricsCore). Consumers import only the names
they use; unused pure-function modules are inert.

Permanent fix is GitHub Packages (`@emoya-cmyk/dashboard-core`) per
`shared-kit/PACKAGES.md` — blocked on the `emoya-cmyk/.github` org repo (A1).
