require('dotenv').config()
const express = require('express')
const cors    = require('cors')
const path    = require('path')
const fs      = require('fs')

const { sseMiddleware } = require('./routes/realtime')
const authRouter         = require('./routes/auth')
const oauthRouter        = require('./routes/oauth')
const clientsRouter      = require('./routes/clients')
const goalsRouter        = require('./routes/goals')
const updatesRouter      = require('./routes/updates')
const metricsRouter      = require('./routes/metrics')
const queryRouter        = require('./routes/query')
const reportsRouter      = require('./routes/reports')
const connectionsRouter  = require('./routes/connections')
const { router: syncRouter } = require('./routes/sync')
const { router: cronRouter } = require('./routes/cron')
const { router: sharesRouter, publicSnapshot } = require('./routes/shares')
const campaignsRouter    = require('./routes/campaigns')
const agencyRouter       = require('./routes/agency')
const aiRouter           = require('./routes/ai')
const seoRouter          = require('./routes/seo')
const insightsRouter     = require('./routes/insights')
const ghlRouter          = require('./routes/webhooks/ghl')
const hubspotRouter      = require('./routes/webhooks/hubspot')
const supermetricsRouter = require('./routes/webhooks/supermetrics')
const { requireAuth }    = require('./middleware/auth')
const { requireAgency, scopeClientParam } = require('./middleware/authz')
const { securityHeaders } = require('./middleware/securityHeaders')
const { createRateLimiter } = require('./middleware/rateLimit')
const { checkProductionSecret } = require('./lib/authSecurity')
const { startScheduler } = require('./scheduler')
const { migrate, query } = require('./db')

const app  = express()
const PORT = process.env.PORT || 3001

// Express advertises itself via X-Powered-By; disabling it at the app level is
// the only reliable way to strip it (Express sets it at send time, after any
// removeHeader() in middleware would have run).
app.disable('x-powered-by')

// Behind Render's TLS proxy the real client IP is in X-Forwarded-For; trust the
// single proxy hop so req.ip (used as the rate-limit key) is the caller, not the
// load balancer. One hop only — never `true` (which would trust a spoofed XFF).
app.set('trust proxy', 1)

// Serverless cold-start guard: block all requests until the migration promise
// resolves. The promise is stored on `app` after the if/else at the bottom;
// by the time a real HTTP request arrives the module has finished loading, so
// the key is always set in serverless mode.
app.use((req, res, next) => {
  const p = app.get('_migrationReady')
  if (p) p.then(() => next()).catch(() => next())
  else next()
})

// ── Middleware ────────────────────────────────────────────────────────────────
// Security headers first so EVERY response (API JSON, SPA bundle, 404s) carries
// the hardening set — before CORS, body parse, and all routes.
app.use(securityHeaders())

app.use(cors({
  origin:  process.env.ALLOWED_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type', 'Authorization',
    'x-ghl-signature', 'x-hubspot-signature', 'x-hubspot-signature-v3',
    'x-supermetrics-secret', 'x-wh-signature',
  ],
}))

// Capture raw body for HMAC verification before JSON parse
app.use((req, res, next) => {
  let buf = []
  req.on('data', chunk => buf.push(chunk))
  req.on('end', () => {
    req.rawBody = Buffer.concat(buf)
    try { req.body = JSON.parse(req.rawBody.toString()) }
    catch { req.body = {} }
    next()
  })
})

// ── Routes ────────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true, ts: new Date().toISOString() }))

// Auth — public (no token needed)
// Brute-force throttle on login: per (IP + email), 20 tries / 15 min by default
// (override via LOGIN_RATE_MAX). CORS absorbs the preflight OPTIONS, so only the
// real POST is counted. Mounted before the auth router so it guards the route.
app.use('/api/auth/login', createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.LOGIN_RATE_MAX) || 20,
  keyFn: (req) => `${req.ip}:${(req.body && req.body.email ? String(req.body.email) : '').toLowerCase()}`,
  message: 'Too many login attempts. Please wait a few minutes and try again.',
}))
app.use('/api/auth', authRouter)

// Google OAuth2 consent flow — public (browser redirect, no JWT)
app.use('/api/auth', oauthRouter)

// Real-time SSE stream
app.get('/api/realtime', sseMiddleware)

// Protected REST APIs
app.use('/api/clients',     requireAuth, clientsRouter)
app.use('/api/goals',       requireAuth, goalsRouter)
app.use('/api/updates',     requireAuth, updatesRouter)
app.use('/api/metrics',     requireAuth, metricsRouter)
app.use('/api/query',       requireAuth, queryRouter)   // semantic query over the atomic fact grain
app.use('/api/reports',     requireAuth, reportsRouter)
app.use('/api/connections', requireAuth, connectionsRouter)
app.use('/api/sync',        requireAuth, syncRouter)
app.use('/api/shares',     requireAuth, sharesRouter)   // create / list / revoke
app.get('/api/share/:token', publicSnapshot)             // public snapshot (no auth)
app.use('/api/campaigns',  requireAuth, campaignsRouter) // campaign CRUD
app.use('/api/agency', agencyRouter)                    // GET public, PUT self-guards with requireAuth
app.use('/api/ai',         requireAuth, aiRouter)        // grounded recap card + ask stub
app.use('/api/seo',        requireAuth, seoRouter)       // SEMrush organic snapshots + on-demand sync
app.use('/api/insights',   requireAuth, insightsRouter)  // autonomous intelligence feed + lifecycle

// Email digest prefs — GET + PUT /api/clients/:id/email
// Defined before the clients router so this specific path wins
app.get('/api/clients/:id/email', requireAuth, scopeClientParam('id'), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT digest_email, digest_enabled FROM clients WHERE id = $1`,
      [req.params.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'not found' })
    res.json(rows[0])
  } catch (err) { res.status(500).json({ error: err.message }) }
})
app.put('/api/clients/:id/email', requireAuth, requireAgency, async (req, res) => {
  const { digest_email, digest_enabled } = req.body
  try {
    const { rows } = await query(
      `UPDATE clients
          SET digest_email = $2, digest_enabled = $3
        WHERE id = $1
        RETURNING digest_email, digest_enabled`,
      [req.params.id, digest_email ?? null, Boolean(digest_enabled)]
    )
    if (!rows.length) return res.status(404).json({ error: 'not found' })
    res.json(rows[0])
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// Unsubscribe — public, no JWT required
app.get('/api/unsubscribe/:token', async (req, res) => {
  try {
    const { rows } = await query(
      `UPDATE clients SET digest_enabled = false
        WHERE unsubscribe_token = $1
        RETURNING name`,
      [req.params.token]
    )
    if (!rows.length) return res.status(404).send('<p>Invalid unsubscribe link.</p>')
    res.send(`<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;text-align:center;padding:60px 20px;color:#374151;">
      <h2 style="font-size:22px;font-weight:900;margin-bottom:8px;">Unsubscribed</h2>
      <p style="color:#6b7280;">${rows[0].name} will no longer receive the weekly digest.</p>
    </body></html>`)
  } catch (err) { res.status(500).send('<p>An error occurred.</p>') }
})

// Webhook receivers
app.use('/api/webhooks/ghl',          ghlRouter)
app.use('/api/webhooks/hubspot',      hubspotRouter)
app.use('/api/webhooks/supermetrics', supermetricsRouter)

// External-cron heartbeat — mounted OUTSIDE requireAuth (a cron service carries
// no user JWT). It self-authenticates with its own constant-time CRON_SECRET
// gate (routes/cron.js → cronAuth), exactly like the webhook receivers above
// self-authenticate with HMAC. This is the always-on substitute that keeps the
// scheduler's idempotent jobs (sync/watchdog/insights) firing when Render's free
// tier has slept the in-process node-cron.
app.use('/api/cron', cronRouter)

// ── Static frontend (production build) ───────────────────────────────────────
// Serve the Vite build so the API and UI are on the same origin in production.
// In dev, the Vite dev server runs separately on port 5173.
const DIST = path.join(__dirname, '../dist')
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST))
  // SPA catch-all: any non-API, non-asset route returns index.html
  app.get(/^(?!\/api\/).*/, (req, res) => {
    res.sendFile(path.join(DIST, 'index.html'))
  })
}

// ── Temporary diagnostic endpoint (remove after login is verified) ─────────
// Read-only: shows user email/hash-prefix/role + clients count so we can
// confirm ensureAdmin() actually wrote to Neon. Gated by a static token.
app.get('/api/__diag', async (req, res) => {
  if (req.query.dbg !== 'cv-diag-2026-06') {
    return res.status(403).json({ error: 'forbidden' })
  }
  try {
    const { rows: users } = await query(
      `SELECT email, role,
              SUBSTRING(password_hash FROM 1 FOR 7) AS hash_prefix,
              created_at
         FROM users ORDER BY created_at`
    )
    const { rows: cc } = await query('SELECT COUNT(*)::int AS n FROM clients')
    res.json({
      users,
      clients_count: cc[0].n,
      ensure_admin_ran: app.get('_ensureAdminRan') || false,
      ensure_admin_error: app.get('_ensureAdminError') || null,
      migrate_error: app.get('_migrateError') || null,
      ts: new Date().toISOString(),
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── 404 catch-all ─────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'not found' }))

// ── Start ─────────────────────────────────────────────────────────────────────
// Fail-closed: in production, refuse to boot with a missing or public-fallback
// JWT_SECRET (every issued token would be forgeable). We never generate or store
// the secret here — that stays an operator gate; we only refuse to run insecurely.
const secretCheck = checkProductionSecret(process.env)
if (!secretCheck.ok) {
  console.error(`[boot] FATAL: ${secretCheck.error}`)
  process.exit(1)
}

// In serverless environments (Vercel) this file is imported as a module;
// listen() and the scheduler only run when executed directly (local dev / Render).
if (require.main === module) {
  migrate().catch(err => console.error('[db] migration error', err.message))

  app.listen(PORT, () => {
    console.log(`[api] http://localhost:${PORT}`)
    console.log(`[api] GHL webhook:      POST /api/webhooks/ghl`)
    console.log(`[api] HubSpot webhook:  POST /api/webhooks/hubspot`)
    console.log(`[api] Supermetrics:     POST /api/webhooks/supermetrics`)
    console.log(`[api] SSE stream:       GET  /api/realtime`)
    console.log(`[api] Manual sync all:  POST /api/sync/all`)

    startScheduler()
  })
} else {
  // Serverless cold-start: run migrations, then ensure admin user + seed demo
  // data. The two steps are DECOUPLED: a migration failure (e.g. an already-
  // applied migration re-throwing on re-run) must NOT prevent ensureAdmin()
  // from running. The users table exists from migration 001; the admin upsert
  // is always safe as long as that table is reachable.
  app.set('_migrationReady', (async () => {
    // ── Step 1: migrations ─────────────────────────────────────────────────
    // db.js now tracks applied files in _migrations and skips already-run
    // ones. Errors are logged and stored but do NOT abort step 2.
    try {
      await migrate()
      console.log('[boot] migrations complete')
    } catch (err) {
      console.error('[db] migration error', err.message)
      app.set('_migrateError', err.message)
      // Continue — core tables from prior deploys still exist.
    }

    // ── Step 2: admin user + seed ──────────────────────────────────────────
    // ensureAdmin() is called UNCONDITIONALLY so the admin password is always
    // correct — even when a prior cold-start already seeded clients (which
    // would block the clients-count gate below). Without this, a pre-existing
    // user row with a wrong hash survives indefinitely.
    try {
      const { ensureAdmin, seed } = require('./seed')
      await ensureAdmin()
      app.set('_ensureAdminRan', true)

      const { rows } = await query('SELECT COUNT(*)::int AS n FROM clients')
      if (rows[0].n === 0) {
        console.log('[boot] empty DB — running full seed…')
        await seed()
        console.log('[boot] seed complete')
      }
    } catch (e) {
      console.error('[boot] auto-seed error', e.message)
      app.set('_ensureAdminError', e.message)
    }
  })())
}

module.exports = app
