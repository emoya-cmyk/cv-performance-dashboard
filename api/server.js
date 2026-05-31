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
const { router: sharesRouter, publicSnapshot } = require('./routes/shares')
const campaignsRouter    = require('./routes/campaigns')
const agencyRouter       = require('./routes/agency')
const aiRouter           = require('./routes/ai')
const ghlRouter          = require('./routes/webhooks/ghl')
const hubspotRouter      = require('./routes/webhooks/hubspot')
const supermetricsRouter = require('./routes/webhooks/supermetrics')
const { requireAuth }    = require('./middleware/auth')
const { startScheduler } = require('./scheduler')
const { migrate, query } = require('./db')

const app  = express()
const PORT = process.env.PORT || 3001

// ── Middleware ────────────────────────────────────────────────────────────────
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

// Email digest prefs — GET + PUT /api/clients/:id/email
// Defined before the clients router so this specific path wins
app.get('/api/clients/:id/email', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT digest_email, digest_enabled FROM clients WHERE id = $1`,
      [req.params.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'not found' })
    res.json(rows[0])
  } catch (err) { res.status(500).json({ error: err.message }) }
})
app.put('/api/clients/:id/email', requireAuth, async (req, res) => {
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

// ── 404 catch-all ─────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'not found' }))

// ── Start ─────────────────────────────────────────────────────────────────────
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
