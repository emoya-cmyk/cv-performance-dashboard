'use strict'

// Per-caller AI budget — a cost guardrail over the LLM-minting routes.
//
// recap / client-brief / portfolio-brief / ask each can trigger a real Anthropic
// call ($ + latency). A stuck client poller or an abusive token could otherwise
// run up an unbounded bill. This caps how many AI mints a SINGLE caller can
// trigger per window, keyed by the authenticated user — so the ceiling is the
// caller's whole AI spend across recap+brief+ask, sharing one bucket (it is the
// caller's budget, not a per-route allowance).
//
// It is a thin, opinionated wrapper over the same dependency-free limiter the
// login throttle uses (middleware/rateLimit). The pure-DB AI routes (ask/explain,
// suggestions, scope-insight, brief-health, lead-policy*, brief-emphasis*, …) are
// deliberately NOT wrapped: they cost a SQL query, not a token, so throttling them
// would only hurt the dashboard without saving a cent.

const { createRateLimiter } = require('./rateLimit')

// Bucket key: the authenticated user id, then its client_id, then the caller IP.
// requireAuth runs before the AI router (server.js), so req.user is populated for
// every request that reaches here; the IP fallback only ever covers a malformed
// token. The 'ai:' prefix namespaces the bucket (harmless — this limiter owns its
// own Map — but keeps keys self-describing in any introspection).
function aiBudgetKey(req) {
  const u = (req && req.user) || {}
  return `ai:${u.id || u.client_id || (req && req.ip) || 'unknown'}`
}

// Build a configured AI-budget limiter. Defaults: 60 mints / hour / caller, tunable
// via AI_RATE_MAX. `skip` / `clock` are pass-throughs for deterministic tests
// (omit them in prod so the limiter uses its default test-runner bypass + real
// clock). Reuses createRateLimiter, so it inherits the X-RateLimit-* headers, the
// Retry-After + 429 JSON on overflow, and the `node --test` bypass (inert unless a
// test opts in with FORCE_RATE_LIMIT=1).
function createAiBudget(opts = {}) {
  const config = {
    windowMs: opts.windowMs != null ? opts.windowMs : 60 * 60 * 1000,
    max: opts.max != null ? opts.max : (Number(process.env.AI_RATE_MAX) || 60),
    keyFn: aiBudgetKey,
    message:
      opts.message != null
        ? opts.message
        : 'AI request budget reached for now. Please wait a few minutes before requesting more AI narration.',
  }
  if (opts.skip) config.skip = opts.skip
  if (opts.clock) config.clock = opts.clock
  return createRateLimiter(config)
}

module.exports = { createAiBudget, aiBudgetKey }
