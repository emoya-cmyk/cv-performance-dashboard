// ============================================================
// test/briefDelivery.integration.test.js — the narration-DELIVERY monitor, wired.
//
// (11a) test/briefDelivery.test.js already pins the PURE assess/narrate core on
// hand-built summaries. This file proves the SEAM layer 11b adds:
//
//   1. THE READ PATH — the exact `delivery` block GET /api/ai/brief-health emits:
//      real ai_briefs rows → lib/brief.listRecentBriefs (DB normalize) →
//      summarizeBriefQuality → assessBriefDelivery → narrateBriefDelivery. Silent
//      on a healthy narrator; a worst-of-two-audience alarm with a self-heal step
//      when our own brief-writer is failing; and — the no-leak boundary the whole
//      403-gated route hangs on — the agency gate (resolvePortfolioScope) plus the
//      client voice that always returns ''.
//
//   2. THE AUTONOMOUS PUSH — lib/emailDigest.sendBriefDeliveryAlert, the agency-only
//      Monday alert. It is NEVER folded into the per-client digest (that one is
//      client-facing); it rides its own BRIEF_ALERT_TO inbox and names model
//      fallbacks a client must never see. Proven graceful: healthy → silent;
//      no recipient / no Resend / empty body → a logged skip, never a throw, never
//      an email — so the scheduler stays self-sustaining whether or not it's wired.
//
// Isolated temp SQLite (same idiom as test/briefHealth.test.js): no network, no LLM,
// and RESEND_API_KEY held unset so the alert's send path resolves to the deterministic
// no-resend skip rather than ever reaching Resend.
// ============================================================
'use strict'

const os     = require('os')
const path   = require('path')
const fs     = require('fs')
const { test } = require('node:test')
const assert = require('node:assert/strict')

// Force SQLite at an isolated path, and hold the two external creds unset, BEFORE
// requiring ../db / ../lib/emailDigest (resend is captured null at module-load).
delete process.env.DATABASE_URL
delete process.env.ANTHROPIC_API_KEY        // never reach a live model
delete process.env.RESEND_API_KEY           // keep resend null → alert send path is the no-resend skip
delete process.env.BRIEF_ALERT_TO           // start from a known-unset recipient
const DB_PATH = path.join(os.tmpdir(), `briefdelivery_${process.pid}.db`)
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
process.env.SQLITE_PATH = DB_PATH

const db = require('../db')
const { listRecentBriefs, PORTFOLIO_KEY }           = require('../lib/brief')
const { summarizeBriefQuality }                     = require('../lib/briefQuality')
const { assessBriefDelivery, narrateBriefDelivery } = require('../lib/briefDelivery')
const { resolvePortfolioScope }                     = require('../routes/ai')
const { sendBriefDeliveryAlert, buildBriefAlertHtml } = require('../lib/emailDigest')

test.after(() => {
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
})

// ── seed helpers (mirror test/briefHealth.test.js) ──────────────────────────────
let migrated = false
async function ready() { if (migrated) return; await db.migrate(); migrated = true }
async function reset() { await ready(); await db.query('DELETE FROM ai_briefs') }
async function seed({ scopeKey, asOf, audience, model, pack, grounded = true, clientId = null }) {
  await db.query(
    `INSERT INTO ai_briefs
       (scope_key, as_of, audience, client_id, model, pack, brief_text, grounded, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CURRENT_TIMESTAMP)`,
    [scopeKey, asOf, audience, clientId, model, JSON.stringify(pack), 'brief.', grounded ? 1 : 0]
  )
}
const clientNarratable = (focus = 'leads') => ({ audience: 'client', focus, meta: { has_focus: true } })
const agencyNarratable = (h = 'Two clients need a look') => ({ audience: 'agency', headline: h, meta: { has_action: true } })
const OPUS = 'claude-opus-4-7'
const TMPL = 'template'

// The exact `delivery` block the route composes from a row window.
function deliveryBlock(rows) {
  const signal = assessBriefDelivery(summarizeBriefQuality(rows))
  return { ...signal, narrative: narrateBriefDelivery(signal, { audience: 'agency' }) }
}

// Signals captured across tests (node:test runs top-level tests sequentially in
// registration order, so a later push-gating test can reuse an earlier DB-derived
// signal without re-seeding).
let HEALTHY_SIGNAL = null
let STALLED_SIGNAL = null
let STALLED_NARR   = ''

// ── 1. healthy history → the route stays silent ─────────────────────────────────
test('read path — an all-narrated history yields delivery ok / no alert / empty narrative', async () => {
  await reset()
  for (const d of ['2026-05-01', '2026-05-02', '2026-05-03']) {
    await seed({ scopeKey: 'C1',          asOf: d, audience: 'client', model: OPUS, pack: clientNarratable() })
    await seed({ scopeKey: PORTFOLIO_KEY, asOf: d, audience: 'agency', model: OPUS, pack: agencyNarratable() })
  }
  const rows = await listRecentBriefs({ asOf: '2026-05-03', days: 30 })
  const d = deliveryBlock(rows)

  assert.equal(d.status, 'ok')
  assert.equal(d.severity, 'info')
  assert.equal(d.alert, false)
  assert.equal(d.audience, null)
  assert.equal(d.action, null)
  assert.equal(d.narrative, '')                         // silent on healthy — the whole point
  assert.equal(d.streams.client.status, 'ok')
  assert.equal(d.streams.agency.status, 'ok')

  HEALTHY_SIGNAL = assessBriefDelivery(summarizeBriefQuality(rows))
})

// ── 2. stalled agency narrator → agency-driven alarm; client voice stays silent ──
test('read path — a stalled agency narrator drives a critical, agency-voiced delivery alarm', async () => {
  await reset()
  // client narrated 4 mornings (its stream is ok)
  for (const d of ['2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05']) {
    await seed({ scopeKey: 'C1', asOf: d, audience: 'client', model: OPUS, pack: clientNarratable() })
  }
  // agency narrated once, then fell back the last 3 mornings running (latest 05-05)
  await seed({ scopeKey: PORTFOLIO_KEY, asOf: '2026-05-02', audience: 'agency', model: OPUS, pack: agencyNarratable() })
  for (const d of ['2026-05-03', '2026-05-04', '2026-05-05']) {
    await seed({ scopeKey: PORTFOLIO_KEY, asOf: d, audience: 'agency', model: TMPL, pack: agencyNarratable() })
  }

  const rows = await listRecentBriefs({ asOf: '2026-05-05', days: 30 })
  const d = deliveryBlock(rows)

  assert.equal(d.status, 'stalled')
  assert.equal(d.severity, 'critical')
  assert.equal(d.alert, true)
  assert.equal(d.reason, 'stalled-streak')
  assert.equal(d.audience, 'agency')
  assert.equal(d.streak, 3)
  assert.equal(d.latest_as_of, '2026-05-05')
  assert.match(d.action, /narration model now/i)
  assert.match(d.narrative, /portfolio morning brief has fallen back/i)
  assert.match(d.narrative, /3 times running/)
  assert.match(d.narrative, /most recent 2026-05-05/)
  assert.match(d.narrative, /grounded/i)               // the GROUNDED_TAIL invariant
  assert.equal(d.streams.client.status, 'ok')
  assert.equal(d.streams.agency.status, 'stalled')

  // no-leak: the SAME signal narrated to a client says nothing at all
  STALLED_SIGNAL = assessBriefDelivery(summarizeBriefQuality(rows))
  STALLED_NARR   = narrateBriefDelivery(STALLED_SIGNAL, { audience: 'agency' })
  assert.equal(narrateBriefDelivery(STALLED_SIGNAL, { audience: 'client' }), '')
})

// ── 3. the push is silent on a healthy narrator ─────────────────────────────────
test('push — sendBriefDeliveryAlert is a no-op on a healthy verdict', async () => {
  assert.deepEqual(await sendBriefDeliveryAlert({ signal: HEALTHY_SIGNAL, narrative: '' }),
    { skipped: true, reason: 'healthy' })
  // defensive: missing/empty args never throw, never email
  assert.deepEqual(await sendBriefDeliveryAlert(),    { skipped: true, reason: 'healthy' })
  assert.deepEqual(await sendBriefDeliveryAlert({}),  { skipped: true, reason: 'healthy' })
})

// ── 4. alert + no recipient → logged skip, never a throw, never a client email ───
test('push — an alert with BRIEF_ALERT_TO unset degrades to a no-recipient skip', async () => {
  delete process.env.BRIEF_ALERT_TO
  assert.deepEqual(
    await sendBriefDeliveryAlert({ signal: STALLED_SIGNAL, narrative: STALLED_NARR, asOf: '2026-05-05' }),
    { skipped: true, reason: 'no-recipient' },
  )
})

// ── 5. alert + recipient but no Resend key → no-resend skip (still no throw) ──────
test('push — a configured recipient with Resend unconfigured yields a no-resend skip', async () => {
  process.env.BRIEF_ALERT_TO = 'ops@agency.test'
  assert.deepEqual(
    await sendBriefDeliveryAlert({ signal: STALLED_SIGNAL, narrative: STALLED_NARR, asOf: '2026-05-05' }),
    { skipped: true, reason: 'no-resend' },
  )
  delete process.env.BRIEF_ALERT_TO
})

// ── 6. alert with an empty body is suppressed before any send ────────────────────
test('push — an alert carrying a blank narrative is suppressed (no-narrative)', async () => {
  process.env.BRIEF_ALERT_TO = 'ops@agency.test'
  assert.deepEqual(
    await sendBriefDeliveryAlert({ signal: STALLED_SIGNAL, narrative: '   ' }),
    { skipped: true, reason: 'no-narrative' },
  )
  delete process.env.BRIEF_ALERT_TO
})

// ── 7. the stalled alert email — rose, agency-internal, self-healing ────────────
test('push — buildBriefAlertHtml renders the stalled alert: rose, no-leak, grounded', () => {
  const html = buildBriefAlertHtml({ narrative: STALLED_NARR, signal: STALLED_SIGNAL, asOf: '2026-05-05' })
  assert.match(html, /#e11d48/)                         // rose band = stalled
  assert.match(html, /has stalled/)
  assert.match(html, /portfolio brief/)                 // the failing stream label
  assert.match(html, /most recent 2026-05-05/)
  assert.match(html, /\/intelligence/)                  // links to the agency Narration Health surface
  assert.match(html, /never receive it/i)               // explicit no-leak reassurance
  assert.match(html, /grounded/i)                       // narrative tail survived into the body
})

// ── 8. the alert email escapes interpolated copy and handles a missing as_of ─────
test('push — buildBriefAlertHtml escapes the narrative and falls back when as_of is null', () => {
  const html = buildBriefAlertHtml({ narrative: 'x < y & z', signal: STALLED_SIGNAL, asOf: null })
  assert.match(html, /x &lt; y &amp; z/)
  assert.match(html, /the latest mornings/)             // null-asOf fallback copy
})

// ── 9. the degraded variant — amber, softer voice ───────────────────────────────
test('push — buildBriefAlertHtml renders the degraded variant in amber', async () => {
  await reset()
  await seed({ scopeKey: 'C1',          asOf: '2026-05-04', audience: 'client', model: OPUS, pack: clientNarratable() })
  await seed({ scopeKey: PORTFOLIO_KEY, asOf: '2026-05-03', audience: 'agency', model: OPUS, pack: agencyNarratable() })
  await seed({ scopeKey: PORTFOLIO_KEY, asOf: '2026-05-04', audience: 'agency', model: TMPL, pack: agencyNarratable() })
  await seed({ scopeKey: PORTFOLIO_KEY, asOf: '2026-05-05', audience: 'agency', model: TMPL, pack: agencyNarratable() })

  const signal = assessBriefDelivery(summarizeBriefQuality(await listRecentBriefs({ asOf: '2026-05-05', days: 30 })))
  assert.equal(signal.status, 'degraded')
  assert.equal(signal.severity, 'warning')
  assert.equal(signal.audience, 'agency')
  assert.equal(signal.streak, 2)

  const html = buildBriefAlertHtml({ narrative: narrateBriefDelivery(signal, { audience: 'agency' }), signal, asOf: '2026-05-05' })
  assert.match(html, /#f59e0b/)                         // amber band = degrading
  assert.match(html, /is degrading/)
  assert.match(html, /fell back/)                       // the degraded narrative verb
  assert.doesNotMatch(html, /#e11d48/)                  // not the rose/stalled accent
})

// ── 10. the no-leak gate the whole delivery surface hangs on ─────────────────────
test('read path — resolvePortfolioScope keeps the delivery block agency-only', () => {
  assert.deepEqual(resolvePortfolioScope({ user: { role: 'agency' } }), {})
  const s = resolvePortfolioScope({ user: { role: 'client', client_id: 'c1' } })
  assert.equal(s.status, 403)
  assert.match(s.error, /not authorized/)
})
