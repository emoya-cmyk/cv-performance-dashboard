'use strict'

// ============================================================================
// lib/alertEngine.js — Phase 4 alert EVALUATION → FIRING loop.
//
// The alert RULES (client_alert_rules), the fired-alert LEDGER (fired_alerts),
// and the DELIVERY fan-out (lib/alertDelivery.js) all already existed; what was
// missing was the loop that EVALUATES a rule against the metrics the dashboard
// already computes and RECORDS a fired_alerts row when a condition is crossed —
// wired so a cron tick drives it without re-firing the same alert every tick.
//
// This module is that loop, factored for the same reasons the heartbeat is:
//   • Dependency-injected — `query` (the only DB seam) and `deliver` (the send
//     fan-out) are passed in, so it is trivially unit-testable with a fake DB and
//     no network. In production the scheduler/heartbeat inject the real ones.
//   • IDEMPOTENT — each fire carries a natural dedup key
//     `${client_id}:${metric}:${period}` and is inserted ON CONFLICT DO NOTHING
//     against the UNIQUE index added in migration 033. A second evaluation in the
//     same window is a no-op insert, so a cron running every tick never spams.
//   • DELIVERY IS GATED — a send is attempted ONLY when (a) the row was NEWLY
//     inserted (rowCount === 1, never on a dedup no-op) AND (b) a channel is
//     configured (Slack webhook or Resend key + recipient). With no channel
//     configured — CI, unconfigured envs — it records the fired alert and sends
//     nothing, so the loop is inert by default.
//
// Reuses the metrics the dashboard already grounds on: the same week-over-week
// comparison of the two most recent weekly_reports rows that the digest and the
// existing scheduler threshold cron use. No new data source is invented.
// ============================================================================

// Is any alert channel configured? Mirrors the gate alertDelivery.sendAlert uses
// internally (Slack webhook, or Resend key + a recipient). Read at CALL time, not
// module load, so arming a channel needs no restart.
function deliveryConfigured() {
  const slack = Boolean(process.env.SLACK_WEBHOOK_URL)
  const email = Boolean(process.env.RESEND_API_KEY && (process.env.ALERT_EMAIL))
  return slack || email
}

// The two threshold checks the rules table describes: a week-over-week DROP in
// revenue or leads beyond the per-client warn/critical fractions. Falls back to
// the same 20% warn / 40% critical defaults the schema and route use.
function buildChecks(rules, curr, prev) {
  const r = rules || {}
  return [
    {
      metric: 'Revenue',
      curr:   Number(curr.revenue),
      prev:   Number(prev.revenue),
      warnAt: Number(r.revenue_drop_warn) || 0.20,
      critAt: Number(r.revenue_drop_crit) || 0.40,
    },
    {
      metric: 'Leads',
      curr:   Number(curr.leads),
      prev:   Number(prev.leads),
      warnAt: Number(r.leads_drop_warn) || 0.20,
      critAt: Number(r.leads_drop_crit) || 0.40,
    },
  ]
}

// Record one fired alert idempotently. Returns true iff a NEW row was inserted
// (rowCount === 1), false if the dedup key already existed (no-op). Works on both
// backends: pg and the sqlite shim both return rowCount, and DO NOTHING yields 0
// rowCount on a conflict.
async function recordFiredAlert(query, alert) {
  const { rowCount } = await query(
    `INSERT INTO fired_alerts
       (severity, title, body, client_id, client_name, metric, value, channel, dedup_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (dedup_key) DO NOTHING`,
    [
      alert.severity   || null,
      alert.title      || null,
      alert.body       || null,
      alert.clientId   || null,
      alert.clientName || null,
      alert.metric     || null,
      alert.value != null ? String(alert.value) : null,
      alert.channel    || null,
      alert.dedupKey,
    ]
  )
  return rowCount === 1
}

/**
 * Evaluate active alert rules against the latest weekly metrics and fire any
 * crossed condition. Idempotent per (client, metric, period); delivery gated.
 *
 * @param {object}   deps
 * @param {function} deps.query     DB query fn (the only DB seam).
 * @param {function} [deps.deliver] async (alert) => any — the send fan-out
 *                                  (defaults to alertDelivery.sendAlert). Called
 *                                  ONLY for newly-fired alerts when a channel is
 *                                  configured.
 * @param {string}   [deps.clientId] restrict evaluation to one client.
 * @param {function} [deps.isConfigured] override the channel-config gate (tests).
 * @returns {Promise<{ evaluated:number, fired:number, delivered:number,
 *                      skipped:number, errors:Array }>}
 *   evaluated = clients with ≥2 weeks of data examined;
 *   fired     = NEW fired_alerts rows written this run;
 *   delivered = newly-fired alerts a send was attempted for;
 *   skipped   = crossed conditions that were already fired this window (dedup).
 */
async function evaluateAlerts(deps = {}) {
  const {
    query,
    deliver,
    clientId,
    isConfigured = deliveryConfigured,
  } = deps

  // Lazy require so the module stays loadable (and unit-testable) without the
  // delivery module's transitive deps; the default sender is the real fan-out.
  const send = deliver || require('./alertDelivery').sendAlert
  const configured = isConfigured()

  const out = { evaluated: 0, fired: 0, delivered: 0, skipped: 0, errors: [] }

  // Pull the most recent ~3 weeks so we always have the latest pair per client.
  // Mirrors the existing scheduler threshold cron's window + grounding.
  const cutoff = new Date()
  cutoff.setUTCDate(cutoff.getUTCDate() - 21)
  const cutoffStr = cutoff.toISOString().slice(0, 10)

  const params = [cutoffStr]
  let clientFilter = ''
  if (clientId) { clientFilter = ' AND wr.client_id = $2'; params.push(clientId) }

  const [{ rows }, { rows: ruleRows }] = await Promise.all([
    query(
      `SELECT wr.client_id, c.name AS client_name, wr.week_start,
              COALESCE(wr.projected_revenue, 0) AS revenue,
              COALESCE(wr.raw_leads, 0)         AS leads
         FROM weekly_reports wr
         JOIN clients c ON c.id = wr.client_id
        WHERE wr.week_start >= $1${clientFilter}
        ORDER BY wr.client_id, wr.week_start DESC`,
      params
    ),
    query(
      `SELECT client_id, revenue_drop_warn, revenue_drop_crit, leads_drop_warn, leads_drop_crit
         FROM client_alert_rules`
    ),
  ])

  const rulesByClient = {}
  for (const r of ruleRows) rulesByClient[r.client_id] = r

  // Latest two weeks per client (rows are DESC by week_start).
  const byClient = {}
  for (const row of rows) {
    if (!byClient[row.client_id]) byClient[row.client_id] = { name: row.client_name, weeks: [] }
    if (byClient[row.client_id].weeks.length < 2) byClient[row.client_id].weeks.push(row)
  }

  for (const [cid, data] of Object.entries(byClient)) {
    const [curr, prev] = data.weeks
    if (!curr || !prev) continue        // need ≥2 weeks to compute a WoW drop
    out.evaluated++

    // Period = the current (later) week being evaluated. The same drop seen again
    // in the same week is the same alert; a fresh week is a fresh window.
    const period = curr.week_start

    const checks = buildChecks(rulesByClient[cid], curr, prev)
    for (const ch of checks) {
      if (ch.prev <= 0) continue         // no baseline → no meaningful drop
      const drop = (ch.prev - ch.curr) / ch.prev
      if (drop <= ch.warnAt) continue    // not crossed
      const pct      = Math.round(drop * 100)
      const severity = drop >= ch.critAt ? 'critical' : 'warning'

      const alert = {
        title:      `${data.name} — ${ch.metric} down ${pct}% WoW`,
        body:       `${data.name} ${ch.metric.toLowerCase()} fell from ${ch.prev.toFixed(0)} to ${ch.curr.toFixed(0)} (−${pct}%) vs the prior week.`,
        severity,
        clientName: data.name,
        clientId:   cid,
        metric:     ch.metric,
        value:      `-${pct}%`,
        dedupKey:   `${cid}:${ch.metric}:${period}`,
      }

      try {
        const isNew = await recordFiredAlert(query, alert)
        if (!isNew) { out.skipped++; continue }   // already fired this window
        out.fired++

        // Delivery is gated: only attempt a send for a NEWLY-fired alert AND only
        // when a channel is configured. Inert in CI / unconfigured envs.
        if (configured) {
          out.delivered++
          try {
            await send(alert)
          } catch (err) {
            out.errors.push({ client_id: cid, metric: ch.metric, error: `deliver: ${err.message}` })
          }
        }
      } catch (err) {
        out.errors.push({ client_id: cid, metric: ch.metric, error: err.message })
      }
    }
  }

  return out
}

module.exports = { evaluateAlerts, deliveryConfigured }
