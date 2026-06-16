'use strict'

// Dependency-free security headers (helmet-equivalent). Ported verbatim from
// agency-performance-dashboard's api/middleware/securityHeaders.js — no behaviour
// change; the only config is the existing hstsMaxAge option.
//
// The codebase hand-rolls its middleware and avoids adding npm deps, so this
// mirrors helmet's safe defaults without the dependency (helmet is NOT installed
// and pulling it in would couple the build to the registry + a transitive tree).
// Mount it first so EVERY response — API JSON, the SPA bundle, 404s, errors —
// carries the set.
//
// Deliberately OMITTED: Content-Security-Policy and Cross-Origin-Embedder-Policy.
// A strict CSP/COEP is the classic helmet footgun for a Vite + Tailwind SPA
// (inline styles, dynamic imports, third-party images); a wrong value
// white-screens the whole app. The headers below are the high-value, zero-risk
// set — a tuned CSP can be layered in later behind real browser testing.

function securityHeaders(options = {}) {
  const hstsMaxAge = options.hstsMaxAge ?? 15552000 // 180 days (helmet default)

  return function securityHeadersMw(_req, res, next) {
    // MIME-sniffing, framing / clickjacking, legacy IE download/cross-domain
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'SAMEORIGIN')
    res.setHeader('X-DNS-Prefetch-Control', 'off')
    res.setHeader('X-Download-Options', 'noopen')
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none')

    // Referrer leakage + cross-origin isolation (no COEP — see note above)
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    res.setHeader('Origin-Agent-Cluster', '?1')

    // HSTS — browsers ignore it over plain http, so it's safe to always send;
    // it only takes effect on the https origin (Render terminates TLS).
    res.setHeader(
      'Strict-Transport-Security',
      `max-age=${hstsMaxAge}; includeSubDomains`
    )

    next()
  }
}

module.exports = { securityHeaders }
