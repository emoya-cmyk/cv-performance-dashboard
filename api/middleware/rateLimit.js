'use strict'

// Thin wrapper over the vendored @emoya-cmyk/dashboard-core rate limiter.
// createRateLimiter, defaultKey, defaultSkip are byte-for-byte identical to the
// canonical module (the only difference was a HANDOFF-reference comment), so cv
// re-exports them from the vendored package (api/vendor/dashboard-core). Public
// export shape is unchanged: { createRateLimiter, defaultKey, defaultSkip }.

const {
  createRateLimiter,
  defaultKey,
  defaultSkip,
} = require('../vendor/dashboard-core')

module.exports = { createRateLimiter, defaultKey, defaultSkip }
