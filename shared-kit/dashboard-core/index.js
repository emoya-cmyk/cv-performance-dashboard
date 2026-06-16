'use strict'

// ─────────────────────────────────────────────────────────────────────────────
// @emoya-cmyk/dashboard-core — canonical core for the dashboard family.
//
// FIRST MODULE: the auth/authz + security layer, extracted from
// agency-performance-dashboard (the reference implementation) and collapsed into
// one reviewed source the three dashboards can share. Everything is exposed as
// dependency-injected factories — the only change from agency is that values it
// read from process.env directly are now config (with agency's env-var defaults,
// so passing nothing behaves exactly like agency today).
//
//   const { createAuth, securityHeaders, createLoginThrottle, createAiBudget,
//           createRateLimiter, authSecurity } = require('@emoya-cmyk/dashboard-core')
//
//   const auth = createAuth({ jwtSecret: process.env.JWT_SECRET })
//   app.use(securityHeaders())
//   app.use('/api/auth/login', createLoginThrottle())
//   app.use('/api/clients', auth.requireAuth, clientsRouter)
//   router.get('/:clientId', auth.scopeClientParam('clientId'), handler)
//   router.use(auth.requireAgency)               // agency-only surface
//   app.use('/api/ai', auth.requireAuth, createAiBudget(), aiRouter)
//
// (engine / connectors / semantic modules to follow — this is the security one.)
// ─────────────────────────────────────────────────────────────────────────────

const {
  createAuth,
  sameId,
  requireAgency,
  scopeClientParam,
  scopeClientQuery,
  scopeClientId,
} = require('./lib/auth')
const { securityHeaders } = require('./lib/securityHeaders')
const { createRateLimiter, defaultKey, defaultSkip } = require('./lib/rateLimit')
const { createLoginThrottle, loginThrottleKey } = require('./lib/loginThrottle')
const { createAiBudget, aiBudgetKey } = require('./lib/aiBudget')
const authSecurity = require('./lib/authSecurity')

module.exports = {
  // Auth/authz layer
  createAuth,
  sameId,
  requireAgency,
  scopeClientParam,
  scopeClientQuery,
  scopeClientId,

  // Security headers
  securityHeaders,

  // Rate limiting + derived guards
  createRateLimiter,
  defaultKey,
  defaultSkip,
  createLoginThrottle,
  loginThrottleKey,
  createAiBudget,
  aiBudgetKey,

  // Auth-hardening primitives (password floor, timing equalizer, boot guard).
  // Exposed both as the namespace and spread for convenience.
  authSecurity,
  validatePassword: authSecurity.validatePassword,
  checkProductionSecret: authSecurity.checkProductionSecret,
  assertJwtSecret: authSecurity.assertJwtSecret,
  DUMMY_HASH: authSecurity.DUMMY_HASH,
  DEV_SECRET_FALLBACK: authSecurity.DEV_SECRET_FALLBACK,
  MIN_PASSWORD_LENGTH: authSecurity.MIN_PASSWORD_LENGTH,
  BCRYPT_MAX_BYTES: authSecurity.BCRYPT_MAX_BYTES,
}
