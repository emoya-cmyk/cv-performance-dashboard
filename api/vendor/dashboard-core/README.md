# @emoya-cmyk/dashboard-core

The canonical **core** for the `emoya-cmyk` dashboard family. One reviewed source
for the building blocks that are otherwise copy-pasted across
`agency-performance-dashboard`, `performance-dashboard`, and
`cv-performance-dashboard`.

**First module: the auth / authz + security layer**, extracted from
`agency-performance-dashboard` (the reference implementation). Everything is a
**dependency-injected factory** — the only change from agency is that values it
read from `process.env` directly are now config, *with agency's env-var defaults*,
so a caller that passes nothing behaves exactly like agency today.

> Roadmap: the security module came first; the **engine** layer has now started
> (increment 1: `baselines`). **connectors / semantic** modules are to follow under
> the same package.

## What's in it
| Export | What it is | Origin in agency |
|--------|------------|------------------|
| `baselines` (+ spread: `summarizeSeries`, `robustStats`, `robustZ`, `linregSlope`, `ewma`, `classifyZ`, `direction`, `median`, `mad`, `mean`, `stddev`, `finite`, `MAD_TO_SIGMA`, `DEFAULT_WARN`, `DEFAULT_CRIT`) | **Engine:** self-calibrating statistics core — per-client/per-metric robust baselines (median/MAD, robust z, linreg slope, EWMA, severity buckets) and the `summarizeSeries` composite the intelligence engine calls. Pure functions, no DB/IO; byte-for-byte identical across cv + agency. | `lib/baselines.js` |
| `createAuth({ jwtSecret })` | JWT-verify + the multi-tenant scope guards, bound to a secret. Returns `{ requireAuth, requireAgency, scopeClientParam, scopeClientQuery, scopeClientId, sameId }`. `scopeClientQuery(param, { mode })` supports `'reject'` (default) and `'clamp'` — see [Use](#use). | `middleware/auth.js` + `middleware/authz.js` |
| `securityHeaders(opts?)` | Dependency-free helmet-equivalent header set (SPA-safe; no CSP/COEP). | `middleware/securityHeaders.js` |
| `createRateLimiter(opts)` | Dependency-free fixed-window limiter (429 + `X-RateLimit-*` + `Retry-After`). | `middleware/rateLimit.js` |
| `createLoginThrottle(opts?)` | Login brute-force throttle (per IP+email, 20/15min default, `LOGIN_RATE_MAX`). | inline in `server.js` |
| `createAiBudget(opts?)` | Per-caller AI-mint budget (60/hr default, `AI_RATE_MAX`). | `middleware/aiBudget.js` |
| `authSecurity` | Password floor (`validatePassword`), login timing equalizer (`DUMMY_HASH`), JWT boot guard (`checkProductionSecret`, `assertJwtSecret`). | `lib/authSecurity.js` |

The auth-security helpers are also spread onto the top level for convenience
(`validatePassword`, `checkProductionSecret`, `assertJwtSecret`, `DUMMY_HASH`,
`DEV_SECRET_FALLBACK`, `MIN_PASSWORD_LENGTH`, `BCRYPT_MAX_BYTES`).

## The model
Two roles, single-agency-per-deploy. JWT payload:
`{ id, email, role: 'agency' | 'client', client_id }`.
- **agency** — trusted staff; may read/manage EVERY client (`client_id` null).
- **client** — pinned to ONE `client_id`; may only ever touch that one client.

Guiding rule everywhere: **FAIL CLOSED** — missing user, an unscoped client token,
or an unknown role is denied (403/401), never default-open.

## Use
```js
const {
  createAuth, securityHeaders, createLoginThrottle, createAiBudget,
  validatePassword, assertJwtSecret,
} = require('@emoya-cmyk/dashboard-core')

// Boot guard: refuse to start in production without a real JWT_SECRET.
assertJwtSecret(process.env)              // throws in prod on missing/dev-fallback secret

const auth = createAuth({ jwtSecret: process.env.JWT_SECRET })

app.use(securityHeaders())                                  // every response

app.use('/api/auth/login', createLoginThrottle())           // before the auth router
app.use('/api/auth', authRouter)

// Authenticated, per-client (IDOR-safe): agency any client; client only its own.
app.use('/api/clients', auth.requireAuth, clientsRouter)
router.get('/:clientId', auth.scopeClientParam('clientId'), handler)

// Query-string client scope: scopeClientQuery(paramName='clientId', { mode='reject' }).
// Agency always passes through. For a 'client' caller, pick the mode:
//   • 'reject' (default) — proceed only if ?clientId matches the caller's own id;
//                          a foreign/missing id is 403 (IDOR-safe, fail closed).
//   • 'clamp'            — rewrite req.query[paramName] to the caller's own id and
//                          proceed, so a client asking for another tenant (or 'all')
//                          still gets 200 but only ever sees its own data.
// In BOTH modes a client with no bound client_id is denied (fail closed).
router.get('/', auth.scopeClientQuery('clientId'), handler)                  // reject (default)
router.get('/summary', auth.scopeClientQuery('client', { mode: 'clamp' }), handler)

// Agency-only surfaces (portfolio reads, client mutations, syncs, share links):
router.use(auth.requireAgency)

// List/clamp endpoints: scopeClientId(req) → the id a client is confined to
// (null for agency). Treat null on a client as "match nothing".
const confine = auth.scopeClientId(req)

// AI-minting routes: cap a single caller's spend.
app.use('/api/ai', auth.requireAuth, createAiBudget(), aiRouter)

// Account creation: enforce the password floor before hashing.
const { ok, error } = validatePassword(password)            // 10-char floor, 72-byte ceiling
```

### Defaults = agency today
Pass nothing and you get agency's exact behaviour:
- `createAuth()` → secret is `process.env.JWT_SECRET || 'dev-secret-change-in-production'`.
- `createLoginThrottle()` → 15-min window, `Number(LOGIN_RATE_MAX) || 20`, keyed by IP+lowercased-email.
- `createAiBudget()` → 1-hour window, `Number(AI_RATE_MAX) || 60`, keyed by user id → client_id → IP.
- The rate limiter's default `skip` bypasses under `node --test` unless `FORCE_RATE_LIMIT=1`.

## Consumption

This package is **not yet wired into any app** — that's a separate, deliberate
step. Two ways to consume it; choose per repo, and mind the deploy-auth tradeoff.

### (a) Git-URL / file dependency — *no registry auth*
```jsonc
// consumer api/package.json
"dependencies": {
  // git URL (after this folder is pushed to its own repo, or a subpath):
  "@emoya-cmyk/dashboard-core": "github:emoya-cmyk/dashboard-core#main"
  // or a local file dep within the monorepo/checkout:
  // "@emoya-cmyk/dashboard-core": "file:../shared-kit/dashboard-core"
}
```
- **Render / Vercel tradeoff:** simplest for CI/deploy — **no `.npmrc` token** to
  configure on the build host. A `github:` URL needs the build to be able to read
  that repo (fine for public, or with a deploy key / `GITHUB_TOKEN` for private);
  a `file:` dep needs the path to exist in the deployed tree (works when the kit
  ships in the same repo, not across separate repos).

### (b) GitHub Packages publish — *registry auth on the build host*
```
# .npmrc in the consuming repo:
@emoya-cmyk:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```
```
npm install @emoya-cmyk/dashboard-core
```
- Publish once: `npm publish` from this folder (`publishConfig.registry` already
  points at GitHub Packages; needs a `packages:write` token).
- **Render / Vercel tradeoff:** clean semver pinning + a normal `npm install`, but
  every build host (Render, Vercel, CI) must provide a **read token** for
  `npm.pkg.github.com` as `NODE_AUTH_TOKEN` (an env var / secret). Forgetting it
  makes `npm ci` fail on the deploy host — the same class of footgun as the
  `production=true` `.npmrc` that silently red-lit CI before.

> Mirrors the same a/b choice documented for `memory-os` in
> `shared-kit/CROSS_REPO_PLAYBOOK.md` (Step 3).

## Dependencies
- `jsonwebtoken` (runtime) — JWT verify, same major as the apps (`^9`).
- `bcryptjs` — an **optional peer dependency**, only needed by a consumer that
  actually hashes/compares (e.g. to use `DUMMY_HASH` in its login route). The
  package itself never imports it at runtime; the test suite pulls it as a dev dep.
- `express` — never a dependency; the middleware only relies on the standard
  `(req, res, next)` signature. Pulled as a dev dep for the integration test.

## Tests
`npm test` (`node --test`) — 60 assertions:
- authz unit boundary (`sameId`, `requireAgency`, `scopeClientParam/Query`,
  `scopeClientId`), ported from agency's `authz.test.js` — including
  `scopeClientQuery`'s `reject` (default) and `clamp` modes;
- a self-contained Express **integration** test that mints real agency+client JWTs
  and asserts the 401/403/own-data boundary over HTTP (the package-isolated
  counterpart of agency's `authz.integration.test.js`);
- password floor + timing-equalizer (`DUMMY_HASH`) + boot-guard
  (`checkProductionSecret` / `assertJwtSecret`), from `authSecurity.test.js`;
- the limiter / login-throttle / AI-budget behaviour, from `rateLimit.test.js` +
  `aiBudget.test.js`;
- `securityHeaders`, from `securityHeaders.test.js`.
