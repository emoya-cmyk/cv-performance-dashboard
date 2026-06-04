// Auto-sync scheduler — runs every 6 hours by default
// Iterates all active client_connections and calls runSync for each.
// The schedule can be overridden via SYNC_CRON env var (cron syntax).
//
// External cron alternative (for Render free tier which sleeps):
//   Point a cron service (render.com cron job, GitHub Actions, etc.) to:
//   POST https://your-api.onrender.com/api/sync/all
//   with Authorization: Bearer <CRON_SECRET>  (set CRON_SECRET in env)

const cron           = require('node-cron')
const { query }      = require('./db')
const { runSync }    = require('./routes/sync')
const { sendDigest, sendBriefDeliveryAlert } = require('./lib/emailDigest')
const { getOrGenerateRecap } = require('./lib/recap')
const { runInsightsForAll }  = require('./lib/insights')
const { listRecentBriefs }      = require('./lib/brief')
const { summarizeBriefQuality } = require('./lib/briefQuality')
const { assessBriefDelivery, narrateBriefDelivery } = require('./lib/briefDelivery')
const { runConnectionWatchdog } = require('./lib/connectionWatchdog')

const SCHEDULE          = process.env.SYNC_CRON     || '0 */6 * * *'  // every 6 hours
const DIGEST_SCHEDULE   = process.env.DIGEST_CRON   || '0 8 * * 1'    // Monday 8am UTC
const INSIGHTS_SCHEDULE = process.env.INSIGHTS_CRON || '0 7 * * *'    // daily 7am UTC
const WATCHDOG_SCHEDULE = process.env.WATCHDOG_CRON || '*/15 * * * *' // every 15 minutes

// Minimal stats builder for digest (mirrors deriveStats in metrics.js)
function digestStats(row) {
  const f = k => parseFloat(row?.[k]) || 0
  const spend = f('ads_spend') + f('lsa_spend') + f('meta_spend')
  const rev   = f('projected_revenue')
  return {
    total_revenue: rev,
    total_closed:  f('closed_won'),
    total_leads:   f('raw_leads'),
    roas:          spend > 0 ? rev / spend : 0,
  }
}

const DIGEST_AGG = `
  COALESCE(SUM(ads_spend),0)        AS ads_spend,
  COALESCE(SUM(lsa_spend),0)        AS lsa_spend,
  COALESCE(SUM(meta_spend),0)       AS meta_spend,
  COALESCE(SUM(raw_leads),0)        AS raw_leads,
  COALESCE(SUM(closed_won),0)       AS closed_won,
  COALESCE(SUM(projected_revenue),0) AS projected_revenue
`

function startScheduler() {
  if (!cron.validate(SCHEDULE)) {
    console.warn('[scheduler] invalid SYNC_CRON, using default 0 */6 * * *')
  }

  cron.schedule(SCHEDULE, async () => {
    console.log('[scheduler] starting scheduled sync', new Date().toISOString())

    let total = 0
    let errors = 0

    try {
      const { rows } = await query(
        `SELECT client_id, channel FROM client_connections WHERE is_active = true`
      )

      for (const { client_id, channel } of rows) {
        try {
          const r = await runSync(client_id, channel)
          console.log(`[scheduler] ${channel} → client ${client_id}: ${r.rows} rows`)
          total++
        } catch (err) {
          console.error(`[scheduler] ${channel} → client ${client_id}: ${err.message}`)
          errors++
        }
      }
    } catch (err) {
      console.error('[scheduler] fatal', err)
    }

    console.log(`[scheduler] done — ${total} succeeded, ${errors} failed`)
  })

  console.log(`[scheduler] running on schedule: ${SCHEDULE}`)

  // ── Weekly email digest — Monday 8am ──────────────────────────────────────
  cron.schedule(DIGEST_SCHEDULE, async () => {
    console.log('[digest] starting weekly digest', new Date().toISOString())
    let sent = 0, errors = 0

    const now          = new Date()
    const weekAgo      = new Date(now); weekAgo.setUTCDate(weekAgo.getUTCDate() - 7)
    const twoWeeksAgo  = new Date(now); twoWeeksAgo.setUTCDate(twoWeeksAgo.getUTCDate() - 14)
    const cutCurr      = weekAgo.toISOString().slice(0, 10)
    const cutPrev      = twoWeeksAgo.toISOString().slice(0, 10)
    const thisMonthDay = new Date().toISOString().slice(0, 7) + '-01'

    try {
      const { rows: clients } = await query(
        `SELECT id, name, digest_email, unsubscribe_token
           FROM clients
          WHERE digest_enabled = true AND digest_email IS NOT NULL`
      )

      for (const client of clients) {
        try {
          const [currR, prevR, goalR, updR] = await Promise.all([
            query(`SELECT ${DIGEST_AGG} FROM weekly_reports WHERE client_id = $1 AND week_start >= $2`, [client.id, cutCurr]),
            query(`SELECT ${DIGEST_AGG} FROM weekly_reports WHERE client_id = $1 AND week_start >= $2 AND week_start < $3`, [client.id, cutPrev, cutCurr]),
            query(`SELECT * FROM client_goals   WHERE client_id = $1 AND month = $2 LIMIT 1`, [client.id, thisMonthDay]),
            query(`SELECT * FROM client_updates WHERE client_id = $1 ORDER BY week_start DESC LIMIT 1`, [client.id]),
          ])

          // Grounded AI recap for the same completed week the digest summarizes.
          // getOrGenerateRecap caches in ai_recaps, so the LLM is hit at most once
          // per client-week. Never blocks the send: on any failure we fall back to
          // the manual client_updates note inside buildHtml.
          let recapText = null
          try {
            const recap = await getOrGenerateRecap(client.id)
            recapText = recap?.recap_text || null
          } catch (err) {
            console.error(`[digest] recap failed for ${client.name}: ${err.message}`)
          }

          await sendDigest({
            client,
            stats:     digestStats(currR.rows[0]),
            prevStats: digestStats(prevR.rows[0]),
            goal:      goalR.rows[0] || null,
            update:    updR.rows[0]  || null,
            recap:     recapText,
          })
          console.log(`[digest] ✓ ${client.name} → ${client.digest_email}`)
          sent++
        } catch (err) {
          console.error(`[digest] ✗ ${client.name}: ${err.message}`)
          errors++
        }
      }

      if (!clients.length) console.log('[digest] no clients with digest enabled')
    } catch (err) {
      console.error('[digest] fatal', err)
    }

    console.log(`[digest] done — ${sent} sent, ${errors} errors`)

    // ── Narration self-check — does the agency need to know its OWN brief-writer
    //    is failing? ────────────────────────────────────────────────────────────
    // The digest above is per-client and client-facing; this is its agency-only
    // counterpart. Grade the last 30 mornings of our own narrator and, ONLY when
    // its voice is degrading, push a single internal alert (BRIEF_ALERT_TO) with the
    // self-heal step. Silent + self-healing otherwise — clients already saw the safe,
    // grounded template, so nothing they received was ever wrong. Isolated in its own
    // try so a brief-health hiccup can't disturb the client digest run above, and
    // placed AFTER it so it fires even if the digest loop itself threw.
    try {
      const briefRows = await listRecentBriefs({ asOf: null, days: 30 })
      const signal    = assessBriefDelivery(summarizeBriefQuality(briefRows))
      const narrative = narrateBriefDelivery(signal, { audience: 'agency' })
      const latestAsOf = briefRows.length ? briefRows[briefRows.length - 1].as_of : null
      const r = await sendBriefDeliveryAlert({ signal, narrative, asOf: latestAsOf })
      console.log(`[brief-alert] narrator ${signal.status}` +
        (r.sent ? ` → alerted ${r.to}` : ` (${r.reason})`))
    } catch (err) {
      console.error('[brief-alert] fatal', err.message)
    }
  })

  console.log(`[scheduler] digest on schedule: ${DIGEST_SCHEDULE}`)

  // ── Nightly intelligence sweep — the autonomous heartbeat ─────────────────
  // Runs the full self-improving pass for every client: grade closed projections,
  // learn each client's calibration, detect findings with the learned knobs, and
  // snapshot this month for later grading. No operator involved — this is what
  // makes the layer self-sustaining. Fired before the Monday digest so its email
  // can read fresh insights. runInsightsForAll isolates per-client failures, so a
  // single bad client never sinks the sweep.
  if (!cron.validate(INSIGHTS_SCHEDULE)) {
    console.warn('[insights] invalid INSIGHTS_CRON, using default 0 7 * * *')
  }
  cron.schedule(INSIGHTS_SCHEDULE, async () => {
    console.log('[insights] starting nightly sweep', new Date().toISOString())
    try {
      const r = await runInsightsForAll()
      console.log(`[insights] done — ${r.swept}/${r.clients} clients, ${r.findings} findings, ${r.failed} failed`)
      for (const e of r.errors) console.error(`[insights] client ${e.client_id}: ${e.error}`)
    } catch (err) {
      console.error('[insights] fatal', err)
    }
  })

  console.log(`[scheduler] insights on schedule: ${INSIGHTS_SCHEDULE}`)

  // ── Self-healing pipeline watchdog — every 15 minutes (intel-v11) ─────────────
  // The 6-hour sync sweep above is the bulk heartbeat; this is the tight, SELECTIVE,
  // backoff-gated recovery loop that keeps channels from going dark between sweeps. It
  // reads every connection's recent sync history, lets the brain (connectionHealth) judge
  // each one, and re-syncs ONLY the connections whose deterministic exponential backoff
  // has come due — never hammering, always plateauing, never giving up on a transient
  // fault. The Class-C invariant is absolute: AUTH failures (operator_required) are never
  // in the due set, so a revoked credential is surfaced for a human reconnect and NEVER
  // auto-retried. runConnectionWatchdog isolates each connection's failure, so one bad
  // re-sync can't sink the sweep. An in-flight guard skips a tick if the previous sweep
  // is still running (a long recovery batch must never stack on itself).
  if (!cron.validate(WATCHDOG_SCHEDULE)) {
    console.warn('[watchdog] invalid WATCHDOG_CRON, using default */15 * * * *')
  }
  let watchdogRunning = false
  cron.schedule(WATCHDOG_SCHEDULE, async () => {
    if (watchdogRunning) {
      console.log('[watchdog] previous sweep still running — skipping this tick')
      return
    }
    watchdogRunning = true
    try {
      const r = await runConnectionWatchdog({ query, runSync, logger: console })
      console.log(
        `[watchdog] swept ${r.scanned} — ${r.healed} re-synced, ${r.failed} failed, ` +
        `${r.operator_required} need reconnect`
      )
    } catch (err) {
      console.error('[watchdog] fatal', err.message)
    } finally {
      watchdogRunning = false
    }
  })

  console.log(`[scheduler] watchdog on schedule: ${WATCHDOG_SCHEDULE}`)
}

module.exports = { startScheduler }
