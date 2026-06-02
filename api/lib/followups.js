'use strict'

// ============================================================
// lib/followups.js — intel-v6 (4): conversational follow-up suggestions.
//
// A single answer is a dead end: the consumer reads "Revenue was $128k, up 23%"
// and then has to think of what to type next. This module turns every answer into
// a branch point — it proposes the 2-4 most useful NEXT questions as click-to-run
// chips, so exploring the data feels like a conversation instead of a search box.
//
// THE ONE HARD RULE — every follow-up must be PARSER-STABLE. A chip is just a
// natural-language string we hand straight back to runAsk → parseQuestion. So each
// string is built ONLY from the trigger vocabulary the parser's own mapping rules
// recognise (see PARSE_SYSTEM in ask.js):
//   • metric:   "revenue" · "leads" · "jobs"(win) · "ad spend" · "ROAS" ·
//               "cost per lead" · "close rate"
//   • group_by: "by week" → week · "by month" → month · "which clients …" → client
//   • order:    "the most"/"the highest" → desc · "the lowest" → asc
//   • time:     "last week" · "in the last 4/12 weeks" · "this month" /
//               "last month" / "this year" · "March 2026"-style → month
// so a clicked chip deterministically re-derives the spec we intended. We NEVER
// emit an intent the grammar can't express — there is no "why did it change?" chip,
// because that would parse to nothing and 422 on click. Every chip is a pivot of
// exactly ONE dimension (metric, window, or grouping) away from the answered spec.
//
// PURE + DB-FREE + LLM-FREE: given the spec that was just answered, we return the
// chips. The labels/whitelist come from ask.js's METRICS (single source of truth),
// so a metric added there flows here for free.
//
// REQUIRE EDGE (identical to suggest.js): we top-level require('./ask') for METRICS;
// therefore ask.js must require('./followups') LAZILY inside runAsk — never at its
// module top — or this destructure races to undefined. Keep it lazy there.
// ============================================================

const { METRICS, GROUPINGS, TIME_RANGES } = require('./ask')

// ── PRESENTATION VOCABULARY (parser-stable by construction) ───────────────────
// How each metric is NAMED inside a question. Every noun here is a phrase the
// parser maps unambiguously back to its metric key.
const NOUN = {
  revenue:    'revenue',
  leads:      'leads',
  jobs:       'jobs',
  spend:      'ad spend',
  roas:       'ROAS',
  cpl:        'cost per lead',
  close_rate: 'close rate',
}

// The comparative word for a "which clients …" ranking, per metric. It encodes the
// SORT DIRECTION the parser will derive ("the most"/"the highest" → desc, "the
// lowest" → asc) so the chip's wording and the answer's ranking always agree. cpl
// is the lone down-good metric, so its best clients are the LOWEST.
const RANK_WORD = {
  revenue:    'the most',
  leads:      'the most',
  jobs:       'the most',
  spend:      'the most',
  roas:       'the highest',
  close_rate: 'the highest',
  cpl:        'the lowest',
}

// The time clause for each range. Leading prepositions are chosen so the clause
// reads naturally after every question stem ("… revenue in the last 4 weeks?").
const TIME_CLAUSE = {
  last_week:     'last week',
  last_4_weeks:  'in the last 4 weeks',
  last_12_weeks: 'in the last 12 weeks',
  this_month:    'this month',
  last_month:    'last month',
  this_year:     'this year',
  all_time:      'all time',
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

// 'YYYY-MM' → "in March 2026", which the parser maps to time_range:'month'. Null
// when the month string is malformed (caller falls back to last_week first).
function monthClause(ym) {
  const mm = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(ym || ''))
  if (!mm) return null
  return `in ${MONTH_NAMES[Number(mm[2]) - 1]} ${mm[1]}`
}

// The standard "zoom out" target for each window, and its chip label. Targets are
// chosen so the wider window is itself comparable where possible (last_4_weeks /
// last_12_weeks both carry a period-over-period delta), so widening tends to ADD a
// "vs" figure rather than drop one. Ranges with no honest wider standard window
// (this_year, all_time, a named month) simply offer no time pivot.
const WIDEN = {
  last_week:     'last_4_weeks',
  last_4_weeks:  'last_12_weeks',
  last_12_weeks: 'this_year',
  this_month:    'this_year',
  last_month:    'this_year',
}
const WIDEN_LABEL = {
  last_4_weeks:  'Last 4 weeks',
  last_12_weeks: 'Last 12 weeks',
  this_year:     'This year',
}

// Adjacent metric to pivot to — the funnel/efficiency neighbour that best explains
// or extends the current one. First entry is preferred; we take the first that's a
// real metric. (revenue←→leads←→jobs is the volume funnel; spend/roas/cpl is the
// efficiency cluster.)
const ADJACENT = {
  revenue:    ['leads', 'roas'],
  leads:      ['jobs', 'cpl'],
  jobs:       ['revenue', 'close_rate'],
  spend:      ['roas', 'leads'],
  roas:       ['revenue', 'spend'],
  cpl:        ['leads', 'spend'],
  close_rate: ['jobs', 'leads'],
}

// A "by week" trend wants a multi-week span; a single week or a month would be
// degenerate. Keep an already-4-week window at 4; otherwise show ~12 weekly
// buckets (the template caps display at 12 with a "+N more" tail).
function trendRange(tr) {
  return tr === 'last_4_weeks' ? 'last_4_weeks' : 'last_12_weeks'
}

// ── QUESTION RENDERING (the parser-stable strings) ────────────────────────────
const timeClause = (tr, month) => (tr === 'month' ? monthClause(month) : TIME_CLAUSE[tr]) || 'last week'

// Single-figure (group_by:none) question. Per-metric stems mirror suggest.js's
// QUESTION map exactly at "last week", so a metric pivot off a last-week answer is
// byte-identical to the opening mover chip for that metric.
function totalQuestion(metric, tc) {
  switch (metric) {
    case 'revenue':    return `What was our revenue ${tc}?`
    case 'leads':      return `How many leads did we get ${tc}?`
    case 'jobs':       return `How many jobs did we win ${tc}?`
    case 'spend':      return `How much did we spend on ads ${tc}?`
    case 'roas':       return `What was our ROAS ${tc}?`
    case 'cpl':        return `What was our cost per lead ${tc}?`
    case 'close_rate': return `What was our close rate ${tc}?`
    default:           return `What was our ${NOUN[metric] || metric} ${tc}?`
  }
}

function renderQuestion(t) {
  const tc = timeClause(t.time_range, t.month)
  if (t.group_by === 'week')   return `Show our ${NOUN[t.metric]} by week ${tc}.`
  if (t.group_by === 'month')  return `Show our ${NOUN[t.metric]} by month ${tc}.`
  if (t.group_by === 'client') return `Which clients had ${RANK_WORD[t.metric]} ${NOUN[t.metric]} ${tc}?`
  return totalQuestion(t.metric, tc)
}

// Identity of a target for de-duplication: a follow-up that re-asks the SAME
// metric/grouping/window as the answer just shown is dropped (order is implied by
// the grouping+metric so it isn't part of the signature).
const sig = (t) => `${t.metric}|${t.group_by}|${t.time_range}|${t.month || ''}`

// First adjacent metric that's a real metric, as a candidate of the given shape.
function adjacentMetric(metric, group_by, time_range, month) {
  const adj = (ADJACENT[metric] || []).find((a) => METRICS[a])
  return adj ? { metric: adj, group_by, time_range, month, kind: 'metric', label: METRICS[adj].label } : null
}

/**
 * Propose the next questions to ask, given the spec that was just answered.
 *
 * @param {object} spec  the answered query-spec ({ metric, group_by, time_range, month? }).
 * @param {object} [opts]
 * @param {boolean} [opts.hasComparison=false]      did the answer already carry a
 *   period-over-period delta? When false on a single figure we surface the "widen
 *   the window" pivot first, since the most valuable next step is to get a "vs".
 * @param {boolean} [opts.allowClientBreakdown=false]  may we offer a cross-client
 *   ranking? True only for an agency view of the whole book — a client-scoped
 *   surface would just collapse "which clients" to its own total, so we suppress it.
 * @param {number} [opts.limit=3]                   max chips (clamped 1..5).
 * @returns {Array<{question:string, label:string, kind:string}>}  ordered, deduped.
 *   kind ∈ 'metric' | 'time' | 'trend' | 'clients' | 'total'.
 */
function suggestFollowups(spec, opts = {}) {
  if (!spec || !METRICS[spec.metric]) return []   // can't pivot off an unknown metric
  const hasComparison        = !!opts.hasComparison
  const allowClientBreakdown = !!opts.allowClientBreakdown
  const limit = Math.min(5, Math.max(1, Math.trunc(Number(opts.limit)) || 3))

  const metric   = spec.metric
  let group_by = GROUPINGS.has(spec.group_by) ? spec.group_by : 'none'
  // A cross-client ranking is meaningless on a client-scoped surface (the caller
  // only ever sees their own data, so it collapsed to a single figure anyway).
  // Treat such a source as the single figure it is, so no "which clients" pivot
  // is ever offered there — invariant: allowClientBreakdown:false ⟹ no client chip.
  if (group_by === 'client' && !allowClientBreakdown) group_by = 'none'

  // Normalise the window. A "month" range with a missing/garbled month can't be
  // re-phrased stably ("that month" parses to nothing) → fall back to last_week.
  let time_range = TIME_RANGES.has(spec.time_range) ? spec.time_range : 'last_week'
  let month = spec.month
  if (time_range === 'month' && !monthClause(month)) { time_range = 'last_week'; month = undefined }

  const cands = []   // ordered by priority; rendered + deduped + sliced below

  if (group_by === 'none') {
    const wider     = WIDEN[time_range]
    const timeCand  = wider ? { metric, group_by: 'none', time_range: wider, month: undefined, kind: 'time', label: WIDEN_LABEL[wider] } : null
    const trendCand = { metric, group_by: 'week', time_range: trendRange(time_range), month: undefined, kind: 'trend', label: 'By week' }
    const clientCand = allowClientBreakdown ? { metric, group_by: 'client', time_range, month, kind: 'clients', label: 'By client' } : null
    const adjCand   = adjacentMetric(metric, 'none', time_range, month)

    if (!hasComparison && timeCand) cands.push(timeCand)   // no "vs" yet → get context first
    cands.push(trendCand)
    if (clientCand) cands.push(clientCand)
    if (adjCand) cands.push(adjCand)
    if (hasComparison && timeCand) cands.push(timeCand)    // already have a "vs" → widen last
  } else if (group_by === 'client') {
    // A ranking → collapse to the book-wide total, pivot the metric, then widen.
    cands.push({ metric, group_by: 'none', time_range, month, kind: 'total', label: 'Overall total' })
    const adj = adjacentMetric(metric, 'client', time_range, month)
    if (adj) cands.push(adj)
    const wider = WIDEN[time_range]
    if (wider) cands.push({ metric, group_by: 'client', time_range: wider, month: undefined, kind: 'time', label: WIDEN_LABEL[wider] })
  } else {
    // A week/month trend → pivot the metric (keep the trend), collapse to a total,
    // then (agency only) rank the clients over the same window.
    const adj = adjacentMetric(metric, group_by, time_range, month)
    if (adj) cands.push(adj)
    cands.push({ metric, group_by: 'none', time_range, month, kind: 'total', label: 'Overall total' })
    if (allowClientBreakdown) cands.push({ metric, group_by: 'client', time_range, month, kind: 'clients', label: 'By client' })
  }

  const seen = new Set([sig({ metric, group_by, time_range, month })])   // never re-ask the source
  const out = []
  for (const t of cands) {
    const s = sig(t)
    if (seen.has(s)) continue
    seen.add(s)
    out.push({ question: renderQuestion(t), label: t.label, kind: t.kind })
    if (out.length >= limit) break
  }
  return out
}

module.exports = { suggestFollowups }
