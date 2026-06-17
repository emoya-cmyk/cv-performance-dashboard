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
