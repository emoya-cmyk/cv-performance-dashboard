'use strict'

// intel-v7 layer 12b — briefImpactEngine: the editorial-PRECISION join.
//
// Layer 12a (briefImpact.js) is a PURE grader: hand it a list of lead OBSERVATIONS
// (each = a thing a morning brief led with, plus the day-pulse follow-ups that came
// after) and it returns an earned/fair/overcalled hit-rate. This engine is the half
// that earns its keep: it READS the persisted briefs we actually shipped, REPLAYS the
// same self-tuning day-pulse sensor over the mornings that FOLLOWED each lead, and
// feeds the resulting observations into summarizeBriefImpact. The output answers a
// question no other layer does — "when we put something at the TOP of the brief, did
// the move we flagged actually hold up over the next few mornings, or were we
// overcalling?" — i.e. the editorial precision of our lead SELECTION, measured against
// ground truth, with zero human grading.
//
// WHY A SEPARATE MODULE (not insights.js): brief.js already requires insights.js
// (loadDailySeries et al.), so insights.js must NOT require brief.js — that would be a
// cycle. This engine sits ABOVE both: it requires brief.js (listRecentBriefs) AND
// insights.js (loadDailySeries + the pulse constants) AND the standalone pulse modules.
// Nothing requires it back, so the graph stays acyclic.
//
// FAITHFUL REPLAY (the metricContinuity convention, pulseContinuity.js): for each
// (client, metric) we grade the metric's FULL loaded series ONCE — pulseAccuracy →
// tunePulseThresholds — and reuse that single {warn, crit} band for every follow-up
// morning. A follow-up at morning D+k is then dayPulse(series.slice(0, idxOf(D+k)+1),
// band): a morning-ending PREFIX, judged on its own full history at the fixed band.
// This is deliberate. dayPulse's baseline loop consumes EVERY non-overlapping prior
// window in the array it's handed, so an unbounded re-slice with a longer prefix would
// silently add baseline windows and could flip a verdict; the single-tune + growing
// morning-ending prefix is the only replay that's both stable and honest. A follow-up
// morning past the end of the loaded corpus is simply ABSENT (fewer usable follow-ups
// → the lead grades 'unknown' and abstains) — never fabricated.

const { query } = require('../db')
const { listRecentBriefs } = require('./brief')
const {
  loadDailySeries,
  METRIC_META,
  PULSE_METRICS,
  PULSE_WINDOW,
  PULSE_LOOKBACK_DAYS,
} = require('./insights')
const { dayPulse } = require('./dayPulse')
const { pulseAccuracy } = require('./pulseAccuracy')
const { tunePulseThresholds } = require('./pulseTuning')
const { summarizeBriefImpact } = require('./briefImpact')

// A follow-up horizon beyond a couple of weeks isn't editorial precision, it's a
// different metric (durability); clamp to keep the replay bounded and meaningful.
const MAX_WINDOW = 14

function clampWindow(w) {
  const n = Math.floor(Number(w))
  if (!Number.isFinite(n) || n < 1) return PULSE_WINDOW
  return Math.min(n, MAX_WINDOW)
}

// The metric's adverse POLARITY: good-when-up metrics (revenue/leads/jobs) go adverse
// on a 'drop'; the lone good-when-down metric (spend) goes adverse on a 'spike'. Mirrors
// getClientPulse's `meta.goodWhenUp ? 'drop' : 'spike'` exactly so the replay sensor is
// byte-identical to the live one.
function adverseWhenFor(metric) {
  const meta = METRIC_META[metric]
  return meta && meta.goodWhenUp === false ? 'spike' : 'drop'
}

// Was the brief's CALL an adverse one? The brief persisted a DIRECTION ('up'/'down') —
// what it actually told the reader. That call is adverse iff its direction is the
// bad-way for this metric: a 'drop' metric is adverse when it said 'down'; a 'spike'
// metric is adverse when it said 'up'. This is the leadAdverse that classifyLeadOutcome
// matches each follow-up's own adverse flag against.
function leadAdverseFor(metric, direction) {
  return adverseWhenFor(metric) === 'spike' ? direction === 'up' : direction === 'down'
}

// Pull the LEAD out of a persisted brief pack: agency briefs lead with `pack.headline`,
// client briefs with `pack.focus`. Returns null (→ row contributes nothing) unless the
// lead names a flow metric we can replay (revenue/leads/spend/jobs) and carries a usable
// direction. `focus`/`headline` only exist on a firing signal, so direction is in
// practice 'up'/'down'; the guard just refuses anything malformed.
function leadOf(row) {
  const pack = row && row.pack
  if (!pack || typeof pack !== 'object') return null
  const lead = row.audience === 'agency' ? pack.headline : pack.focus
  if (!lead || typeof lead !== 'object') return null
  if (!PULSE_METRICS.includes(lead.metric)) return null
  if (typeof lead.direction !== 'string') return null
  return lead
}

// Which client's series do we replay against? A client brief is keyed by the client id
// directly (client_id, falling back to scope_key). An agency headline names a CLIENT by
// display name, so we resolve it through the name→id index; unresolved → null (honest
// skip — we never guess a client).
function clientIdFor(row, lead, nameToId) {
  if (row.audience === 'agency') {
    const name = lead.client_name
    return name != null && nameToId.has(name) ? nameToId.get(name) : null
  }
  return row.client_id != null ? row.client_id : row.scope_key
}

async function loadClientNameIndex() {
  const { rows } = await query('SELECT id, name FROM clients')
  const m = new Map()
  for (const r of rows || []) {
    if (r && r.name != null) m.set(r.name, r.id)
  }
  return m
}

// getBriefImpact({ asOf, days, window }) — the editorial-precision read.
//   asOf   : spine end (defaults to today inside loadDailySeries/listRecentBriefs)
//   days   : how far back to pull shipped briefs (clamped [1,365] by listRecentBriefs)
//   window : follow-up horizon per lead (mornings after the lead we replay)
// Returns whatever summarizeBriefImpact returns — status/label/hit_rate + by_lane +
// by_audience — so the route can spread it straight onto the response.
async function getBriefImpact({ asOf, days = 30, window = PULSE_WINDOW } = {}) {
  const win = clampWindow(window)
  const rows = await listRecentBriefs({ asOf, days })
  const nameToId = await loadClientNameIndex()

  // Bucket each shipped brief's LEAD by the client whose series confirms it, so we load
  // each client's dense daily series exactly ONCE.
  const byClient = new Map() // clientId -> [{ as_of, audience, metric, direction, lane }]
  for (const row of rows || []) {
    const lead = leadOf(row)
    if (!lead) continue
    const clientId = clientIdFor(row, lead, nameToId)
    if (clientId == null) continue
    if (!byClient.has(clientId)) byClient.set(clientId, [])
    byClient.get(clientId).push({
      as_of: row.as_of,
      audience: row.audience,
      metric: lead.metric,
      direction: lead.direction,
      lane: lead.lane != null ? lead.lane : null,
    })
  }

  const observations = []
  for (const [clientId, leads] of byClient) {
    // ONE dense load per client, ending at asOf, spanning back far enough that even the
    // OLDEST brief morning has a full pulse baseline behind it AND the follow-up horizon
    // ahead of it sits inside the corpus: days (oldest brief) + lookback (baseline) +
    // window (horizon).
    const span = days + PULSE_LOOKBACK_DAYS + win
    let dates, series
    try {
      ;({ dates, series } = await loadDailySeries(clientId, { asOf, windowDays: span }))
    } catch {
      continue // a client whose series can't load simply contributes no observations
    }
    if (!Array.isArray(dates) || dates.length === 0) continue
    const idxOf = new Map(dates.map((d, i) => [d, i]))
    const lastIdx = dates.length - 1

    // ONE tuned band per metric for THIS client (metricContinuity convention): grade the
    // full loaded series once, memoize the {warn,crit} for every follow-up replay below.
    const tunedFor = new Map()
    const tuneFor = (metric) => {
      if (tunedFor.has(metric)) return tunedFor.get(metric)
      const adverseWhen = adverseWhenFor(metric)
      const xs = series[metric] || []
      const acc = pulseAccuracy(xs, { window: win, adverseWhen })
      const tune = tunePulseThresholds(acc)
      const opts = { window: win, adverseWhen, warn: tune.warn, crit: tune.crit }
      tunedFor.set(metric, opts)
      return opts
    }

    for (const lead of leads) {
      const xs = series[lead.metric]
      if (!Array.isArray(xs) || xs.length === 0) continue
      const d0 = idxOf.get(lead.as_of)
      if (d0 == null) continue // brief morning outside the loaded spine — abstain
      const opts = tuneFor(lead.metric)
      const followups = []
      for (let k = 1; k <= win; k++) {
        const ti = d0 + k
        if (ti > lastIdx) break // follow-up morning past corpus end — honestly absent
        const v = dayPulse(xs.slice(0, ti + 1), opts)
        followups.push({ status: v.status, adverse: v.adverse })
      }
      observations.push({
        audience: lead.audience,
        lane: lead.lane,
        adverse: leadAdverseFor(lead.metric, lead.direction),
        followups,
      })
    }
  }

  return summarizeBriefImpact(observations, { window: win })
}

module.exports = { getBriefImpact }
