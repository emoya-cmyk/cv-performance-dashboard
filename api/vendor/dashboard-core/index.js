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
// ENGINE (increment 1): the first pure-math engine module — `baselines`, the
// self-calibrating statistics core (median/MAD/robust-z, linreg slope, EWMA,
// severity buckets, and the `summarizeSeries` composite). Byte-for-byte
// identical across cv + agency, no DB/IO — a true dedup, exported as-is.
//
//   const { summarizeSeries, robustStats } = require('@emoya-cmyk/dashboard-core')
//
// ENGINE (increment 2): the pure-math analysis modules — `forecast` (Holt
// double-exponential smoothing / projection / ETA), `attribution` &
// `ratioAttribution` (composite/ratio change decomposition), `pacing`
// (target-pace classification), `precision` (outcome confidence / Beta-Bernoulli
// banding), `correlate` (coverage→impact linkage), and `contribution` (additive
// breakdown). Byte-for-byte identical across cv + agency, no DB/IO — a true
// dedup, exported as-is.
//
// (more connectors / semantic modules to follow.)
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
const baselines = require('./lib/baselines')
const forecastNs = require('./lib/forecast')
const attribution = require('./lib/attribution')
const pacing = require('./lib/pacing')
const precision = require('./lib/precision')
const correlate = require('./lib/correlate')
const contribution = require('./lib/contribution')
const ratioAttribution = require('./lib/ratioAttribution')

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

  // Engine — self-calibrating statistics (baselines). Exposed both as the
  // namespace and spread, so cv's `lib/baselines.js` can re-export the exact
  // same public shape with no call-site changes.
  baselines,
  finite: baselines.finite,
  mean: baselines.mean,
  stddev: baselines.stddev,
  median: baselines.median,
  mad: baselines.mad,
  robustStats: baselines.robustStats,
  robustZ: baselines.robustZ,
  linregSlope: baselines.linregSlope,
  ewma: baselines.ewma,
  classifyZ: baselines.classifyZ,
  direction: baselines.direction,
  summarizeSeries: baselines.summarizeSeries,
  MAD_TO_SIGMA: baselines.MAD_TO_SIGMA,
  DEFAULT_WARN: baselines.DEFAULT_WARN,
  DEFAULT_CRIT: baselines.DEFAULT_CRIT,

  // Engine (increment 2) — the pure-math analysis modules, byte-for-byte
  // identical across cv + agency before extraction. Each is exposed both as its
  // namespace and spread, so cv's `lib/<module>.js` re-exports the exact same
  // public shape with no call-site changes. NOTE: `forecast` exports a function
  // named `forecast`, so the namespace is exposed as `forecastNs` to avoid a
  // duplicate-key collision with that member; the member `forecast` is what call
  // sites destructure. Likewise `ratioAttribution` is both a module and a
  // function; the namespace is exposed as `ratioAttributionNs`.
  forecastNs,
  holt: forecastNs.holt,
  forecast: forecastNs.forecast,
  projectN: forecastNs.projectN,
  etaToTarget: forecastNs.etaToTarget,
  monthEndProjection: forecastNs.monthEndProjection,
  mapeOf: forecastNs.mapeOf,
  DEFAULT_ALPHA: forecastNs.DEFAULT_ALPHA,
  DEFAULT_BETA: forecastNs.DEFAULT_BETA,
  Z_80: forecastNs.Z_80,

  attribution,
  attributeChange: attribution.attributeChange,
  isComposite: attribution.isComposite,
  driversOf: attribution.driversOf,
  compositeMetrics: attribution.compositeMetrics,
  IDENTITIES: attribution.IDENTITIES,

  pacing,
  classifyPacing: pacing.classifyPacing,
  rankPacing: pacing.rankPacing,
  paceStatus: pacing.paceStatus,
  MIN_ELAPSED: pacing.MIN_ELAPSED,
  AHEAD_AT: pacing.AHEAD_AT,
  ON_TRACK_AT: pacing.ON_TRACK_AT,
  BEHIND_AT: pacing.BEHIND_AT,
  STATUS_RANK: pacing.STATUS_RANK,

  precision,
  classifyOutcome: precision.classifyOutcome,
  signatureKey: precision.signatureKey,
  tallyOutcomes: precision.tallyOutcomes,
  rateOf: precision.rateOf,
  confidenceOf: precision.confidenceOf,
  bandOf: precision.bandOf,
  weightFor: precision.weightFor,
  baseRateOf: precision.baseRateOf,
  confidenceTable: precision.confidenceTable,
  PRIOR_WEIGHT: precision.PRIOR_WEIGHT,
  PRIOR_MEAN: precision.PRIOR_MEAN,
  BAND_LOW: precision.BAND_LOW,
  BAND_HIGH: precision.BAND_HIGH,
  WEIGHT_MIN: precision.WEIGHT_MIN,
  WEIGHT_MAX: precision.WEIGHT_MAX,

  correlate,
  linkCoverageToImpact: correlate.linkCoverageToImpact,
  SYMPTOM_KINDS: correlate.SYMPTOM_KINDS,

  contribution,
  contributionBreakdown: contribution.contributionBreakdown,
  narrateContribution: contribution.narrateContribution,
  isAdditive: contribution.isAdditive,
  additiveMetrics: contribution.additiveMetrics,
  ADDITIVE: contribution.ADDITIVE,

  ratioAttributionNs: ratioAttribution,
  ratioAttribution: ratioAttribution.ratioAttribution,
  narrateRatio: ratioAttribution.narrateRatio,
  isRatioMetric: ratioAttribution.isRatioMetric,
  ratioDriversOf: ratioAttribution.ratioDriversOf,
  RATIO_IDENTITIES: ratioAttribution.RATIO_IDENTITIES,
}
