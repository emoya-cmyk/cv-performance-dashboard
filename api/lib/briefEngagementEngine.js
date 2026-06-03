'use strict'
// ============================================================
// briefEngagementEngine — intel-v8 layer 18b: the consumer-feedback DB join.
// ------------------------------------------------------------
// lib/briefEngagement.js (18a) is the PURE grader: hand it a list of
// { as_of, signal } votes and it returns a helpful_rate + label + trend, with
// every bad/missing signal bucketed as an ignored non-vote. THIS module is the
// only one that READS and WRITES the brief_feedback table (migration 019); it
// owns the three real operations the layer needs, and nothing else touches the
// table:
//
//   recordBriefFeedback   — the CONSUMER write. One reversible upsert keyed by
//     (client_id, as_of): a re-vote (👍→👎 or back) OVERWRITES in place. Returns
//     the { as_of, signal } that now stands, so the client UI can reflect it.
//   getClientBriefFeedback — the CONSUMER own-vote read. Returns { as_of, signal }
//     with signal === null when the client has not voted that morning.
//   getPortfolioEngagement — the AGENCY aggregate. Rolls EVERY client's votes over
//     a trailing window into a portfolio grade + a per-client board + a watch list
//     of clients whose reception is poor or declining.
//
// PRIVACY INVARIANT (mirrors the migration header + the pure module): the write
// and the own-vote read are scoped to ONE clientId that the route derives from the
// authenticated TOKEN, never a body param — a client can only ever touch their own
// row. The aggregate is AGENCY-ONLY; it never flows to a client egress (the route
// gates it with resolvePortfolioScope and the pure narrator returns '' for the
// client audience unconditionally). DB shape + lib + route are three guards on the
// same rule.
// ============================================================

const { query } = require('../db')
const { defaultAsOf } = require('./brief')
const {
  summarizeBriefEngagement,
  DEFAULT_MIN_VOTES,
} = require('./briefEngagement')

const HELPFUL = 'helpful'
const NOT_HELPFUL = 'not_helpful'
const VALID_SIGNALS = [HELPFUL, NOT_HELPFUL]

// The agency rollup defaults to a WIDER window than the narration-health reads:
// reception moves slowly (≈ one vote per client per morning), so 90 days gives the
// rate enough sample to be meaningful while still trailing recent sentiment.
const DEFAULT_ENGAGEMENT_DAYS = 90

// Local copy of brief.js's (non-exported) day-stepper — keeps brief.js's export
// surface unchanged (smaller blast radius) at the cost of four trivial lines.
function isoDayMinus(ymd, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''))
  if (!m) return ymd
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - n * 86400000
  return new Date(t).toISOString().slice(0, 10)
}

function clampDays(raw, dflt = DEFAULT_ENGAGEMENT_DAYS) {
  const n = Math.floor(Number(raw))
  if (!Number.isFinite(n) || n < 1) return dflt
  return Math.min(365, n)
}

function isValidSignal(s) {
  return VALID_SIGNALS.includes(s)
}

// ── the consumer WRITE — reversible upsert, returns the vote that now stands ──────
async function recordBriefFeedback({ clientId, asOf, signal } = {}) {
  if (!clientId) throw new Error('clientId is required')
  if (!isValidSignal(signal)) throw new Error('signal must be helpful | not_helpful')
  const day = asOf || defaultAsOf()
  await query(
    `INSERT INTO brief_feedback (client_id, as_of, signal, updated_at)
     VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
     ON CONFLICT (client_id, as_of)
       DO UPDATE SET signal = EXCLUDED.signal, updated_at = CURRENT_TIMESTAMP`,
    [clientId, day, signal]
  )
  return { as_of: day, signal }
}

// ── the consumer own-vote READ — signal null when not yet voted ───────────────────
async function getClientBriefFeedback({ clientId, asOf } = {}) {
  if (!clientId) throw new Error('clientId is required')
  const day = asOf || defaultAsOf()
  const { rows } = await query(
    `SELECT as_of, signal FROM brief_feedback WHERE client_id = $1 AND as_of = $2`,
    [clientId, day]
  )
  const row = rows && rows[0]
  return { as_of: day, signal: row ? row.signal : null }
}

// ── the AGENCY aggregate — portfolio grade + per-client board + watch list ────────
async function getPortfolioEngagement({ asOf, days, minVotes } = {}) {
  const to = asOf || defaultAsOf()
  const win = clampDays(days)
  const from = isoDayMinus(to, win - 1)
  const floor = Number.isInteger(minVotes) && minVotes > 0 ? minVotes : DEFAULT_MIN_VOTES

  const { rows } = await query(
    `SELECT f.client_id, f.as_of, f.signal, c.name
       FROM brief_feedback f
       LEFT JOIN clients c ON c.id = f.client_id
      WHERE f.as_of BETWEEN $1 AND $2`,
    [from, to]
  )
  const list = rows || []

  // portfolio-wide grade: the same pure summarizer over EVERY vote in the window.
  const portfolio = summarizeBriefEngagement(
    list.map((r) => ({ as_of: r.as_of, signal: r.signal })),
    { minVotes: floor }
  )

  // per-client grades: bucket the window by client, grade each independently.
  const byClientMap = new Map()
  for (const r of list) {
    if (r.client_id == null) continue
    if (!byClientMap.has(r.client_id)) {
      byClientMap.set(r.client_id, { name: r.name != null ? r.name : null, events: [] })
    }
    byClientMap.get(r.client_id).events.push({ as_of: r.as_of, signal: r.signal })
  }
  const by_client = []
  for (const [clientId, { name, events }] of byClientMap) {
    by_client.push({ client_id: clientId, name, ...summarizeBriefEngagement(events, { minVotes: floor }) })
  }
  // worst reception first (ungraded sort last), then by name for a stable order.
  by_client.sort((a, b) => {
    const ra = a.helpful_rate == null ? Infinity : a.helpful_rate
    const rb = b.helpful_rate == null ? Infinity : b.helpful_rate
    if (ra !== rb) return ra - rb
    return String(a.name || '').localeCompare(String(b.name || ''))
  })

  // the early-warning board: graded clients whose brief is landing poorly or fading.
  const watch = by_client.filter(
    (c) => c.status === 'graded' && (c.label === 'poorly_received' || c.trend === 'declining')
  )

  return {
    ...portfolio,
    requested_min_votes: floor,
    by_client,
    watch,
    clients_graded: by_client.filter((c) => c.status === 'graded').length,
    clients_total: by_client.length,
  }
}

module.exports = {
  recordBriefFeedback,
  getClientBriefFeedback,
  getPortfolioEngagement,
  VALID_SIGNALS,
  DEFAULT_ENGAGEMENT_DAYS,
}
