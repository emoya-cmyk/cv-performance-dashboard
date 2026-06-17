# Provenance

Vendored from this repo's `shared-kit/dashboard-core` (canonical). Re-sync from
there; do not edit in place.

## Vendored modules

- **Auth / authz + security layer** (`lib/auth.js`, `lib/authSecurity.js`,
  `lib/securityHeaders.js`, `lib/rateLimit.js`, `lib/loginThrottle.js`,
  `lib/aiBudget.js`) — increment 0. cv consumes via the `middleware/*` and
  `lib/authSecurity.js` re-export shims.
- **Engine — `lib/baselines.js`** (self-calibrating statistics core) — increment 1.
  Byte-for-byte identical across cv + agency before extraction; cv's
  `api/lib/baselines.js` is now a thin re-export of this copy. Pure functions, no
  DB/IO.
- **Engine — `lib/forecast.js`, `lib/attribution.js`, `lib/pacing.js`,
  `lib/precision.js`, `lib/correlate.js`, `lib/contribution.js`,
  `lib/ratioAttribution.js`** (the pure-math analysis modules) — increment 2.
  Byte-for-byte identical across cv + agency before extraction; cv's
  `api/lib/<module>.js` are now thin re-exports of these copies. Pure functions,
  no DB/IO. (`forecast` depends on the package-internal `./baselines`.)
- **Engine — `lib/metricsCore.js`** (the single source of truth for derived KPIs:
  the wide `AGG` aggregate, `derive`, `pctChange`, `detectAnomalies`) — increment 3.
  Byte-for-byte identical across cv + agency before extraction; cv's
  `api/lib/metricsCore.js` is now a thin re-export of this copy. Pure functions,
  no DB/IO. Shipped with a characterization test (`test/metricsCore.test.js`)
  written first to pin its observable behavior (totals, guarded ratios, the
  cold-start no-NaN/Infinity hardening, `pctChange` null guard, and the
  `detectAnomalies` threshold/skip/sort).
