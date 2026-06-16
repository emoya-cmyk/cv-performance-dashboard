'use strict'

// Dependency-free fixed-window rate limiter (express-rate-limit equivalent).
// Ported verbatim from agency-performance-dashboard's api/middleware/rateLimit.js
// — no behaviour change. It already takes everything via options (windowMs, max,
// keyFn, skip, message, statusCode, clock), so no env-reading to parameterize.
//
// express-rate-limit / express-slow-down are NOT installed, and the codebase
// hand-rolls its middleware rather than couple the build to the registry. This
// is a small, single-process, in-memory fixed-window counter — exactly what the
// free-tier single dyno needs. (A multi-instance deploy would want a shared
// store; documented as a scale-up note, not a launch blocker.)
//
// Test-safety: the DEFAULT skip bypasses the limiter under the test runner so the
// existing suite is never throttled, UNLESS a test opts in with FORCE_RATE_LIMIT=1
// to exercise the 429 path. Callers that pass their own `skip` replace this.

function defaultKey(req) {
  // req.ip honors `trust proxy`; fall back to the raw socket for non-Express ctx.
  return req.ip || (req.socket && req.socket.remoteAddress) || 'unknown'
}

function defaultSkip(req) {
  return process.env.NODE_ENV === 'test' && process.env.FORCE_RATE_LIMIT !== '1'
}

// options:
//   windowMs   (required) rolling window length in ms
//   max        (required) max requests allowed per key per window
//   keyFn      (req) => string   — bucket key (default: client IP)
//   skip       (req) => boolean  — bypass when true (default: test-runner bypass)
//   message    string body for the 429 (default generic)
//   statusCode number (default 429)
//   clock      () => number ms   — injectable for deterministic tests
function createRateLimiter(options = {}) {
  const {
    windowMs,
    max,
    keyFn = defaultKey,
    skip = defaultSkip,
    message = 'Too many requests, please try again later.',
    statusCode = 429,
    clock = Date.now,
  } = options

  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error('createRateLimiter: windowMs must be a positive number')
  }
  if (!Number.isFinite(max) || max <= 0) {
    throw new Error('createRateLimiter: max must be a positive number')
  }

  const hits = new Map() // key -> { count, resetAt }
  let lastSweep = clock()

  // Lazy sweep — piggybacks on request traffic so an idle process never grows
  // unbounded and we never schedule a timer (keeps the event loop clean for the
  // free-tier dyno + leaves no open handle in tests).
  function sweep(now) {
    for (const [k, v] of hits) {
      if (now >= v.resetAt) hits.delete(k)
    }
    lastSweep = now
  }

  function rateLimit(req, res, next) {
    if (skip(req)) return next()

    const now = clock()
    if (now - lastSweep >= windowMs) sweep(now)

    const key = keyFn(req)
    let entry = hits.get(key)
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs }
      hits.set(key, entry)
    }
    entry.count += 1

    const remaining = Math.max(0, max - entry.count)
    if (typeof res.setHeader === 'function') {
      res.setHeader('X-RateLimit-Limit', String(max))
      res.setHeader('X-RateLimit-Remaining', String(remaining))
      res.setHeader('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)))
    }

    if (entry.count > max) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000))
      if (typeof res.setHeader === 'function') res.setHeader('Retry-After', String(retryAfter))
      return res.status(statusCode).json({ error: message, retryAfter })
    }

    next()
  }

  // Test/introspection hooks (not used in the request path).
  rateLimit.resetStore = () => hits.clear()
  rateLimit._hits = hits

  return rateLimit
}

module.exports = { createRateLimiter, defaultKey, defaultSkip }
