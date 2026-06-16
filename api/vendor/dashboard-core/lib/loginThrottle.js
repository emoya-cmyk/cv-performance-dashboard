'use strict'

// Login brute-force throttle. Agency wires this INLINE at the server.js mount
// (api/server.js): a createRateLimiter keyed by (IP + lowercased email), 20 tries
// / 15 min by default, override via LOGIN_RATE_MAX. There was no standalone
// module for it in agency — it lived in server.js — so the extraction here
// captures that exact configuration as a factory, parameterizing the two values
// agency read literally / from env (the window and the LOGIN_RATE_MAX default).
//
// Mount it before the auth router so it guards POST /api/auth/login:
//   app.use('/api/auth/login', createLoginThrottle())
//   app.use('/api/auth', authRouter)

const { createRateLimiter } = require('./rateLimit')

// Per (IP + email) bucket key, matching agency's server.js mount exactly. CORS
// absorbs the preflight OPTIONS, so only the real POST is counted. The email is
// lowercased so 'A@x' and 'a@x' share a bucket.
function loginThrottleKey(req) {
  const email = req.body && req.body.email ? String(req.body.email) : ''
  return `${req.ip}:${email.toLowerCase()}`
}

// Build the configured login throttle. Defaults reproduce agency's server.js:
//   windowMs — 15 minutes
//   max      — opts.max ?? Number(process.env.LOGIN_RATE_MAX) || 20
//   keyFn    — (IP + lowercased email)
//   message  — agency's login-specific 429 copy
// `skip` / `clock` pass through for deterministic tests; omit in prod for the
// default test-runner bypass + real clock.
function createLoginThrottle(opts = {}) {
  const config = {
    windowMs: opts.windowMs != null ? opts.windowMs : 15 * 60 * 1000,
    max: opts.max != null ? opts.max : (Number(process.env.LOGIN_RATE_MAX) || 20),
    keyFn: opts.keyFn || loginThrottleKey,
    message:
      opts.message != null
        ? opts.message
        : 'Too many login attempts. Please wait a few minutes and try again.',
  }
  if (opts.skip) config.skip = opts.skip
  if (opts.clock) config.clock = opts.clock
  return createRateLimiter(config)
}

module.exports = { createLoginThrottle, loginThrottleKey }
