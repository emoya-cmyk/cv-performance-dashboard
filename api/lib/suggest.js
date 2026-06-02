'use strict'

// ============================================================
// lib/suggest.js — intel-v6 (3): dynamic, data-driven question suggestions.
//
// The Ask box used to open on a STATIC list of four hard-coded prompts. A
// consumer who doesn't already know what to ask gets nothing that reflects what
// actually happened to THEIR numbers. This module turns the blank prompt into a
// guide: it ranks each metric by how much it moved period-over-period for the
// caller's scope and surfaces the biggest movers as click-to-run questions —
// "Revenue up 23.1%", "Cost per lead down 12%" — so the most relevant question
// is one tap away.
//
// PURE + DB-FREE. The caller (lib/ask.runSuggestions) computes each metric's
// current and prior-period total through the SAME scope-safe compile path the
// Ask layer already uses, and hands us the raw { metric, current, baseline }
// pairs. We reuse the Ask layer's OWN computeComparison (delta / % / direction /
// polarity-aware "improved") and formatValue — so a suggestion's headline can
// never disagree with the answer the question would produce, and no model is
// involved: the headline numbers are as grounded as any other figure.
//
// NOTE ON THE REQUIRE EDGE: lib/ask.js pulls runSuggestions in LAZILY (inside the
// function body), never at module top — so by the time this file's top-level
// require('./ask') runs, ask.js has finished loading and its full exports exist.
// Keep it that way or this destructure goes undefined (a classic circular-require
// trap).
// ============================================================

const { computeComparison, formatValue, METRICS } = require('./ask')

// Canonical, parser-stable question per metric. Each NAMES its metric and the
// "last week" timeframe explicitly so parseQuestion maps it deterministically
// back to the SAME spec these movers were computed over (metric · group_by none ·
// last_week) — the clicked answer then re-derives the very comparison that put
// the chip on screen. Phrasing is scope-neutral ("our"): the server scopes the
// query regardless, so the same string reads correctly on the agency and client
// surfaces alike.
const QUESTION = {
  revenue:    'What was our revenue last week?',
  leads:      'How many leads did we get last week?',
  jobs:       'How many jobs did we win last week?',
  spend:      'How much did we spend on ads last week?',
  roas:       'What was our ROAS last week?',
  cpl:        'What was our cost per lead last week?',
  close_rate: 'What was our close rate last week?',
}

// Sort weight — bigger surfaces sooner. A concrete |%-change| is the natural
// magnitude. A jump from a ZERO baseline has no defined % (undefined ratio we
// never fabricate) but is a strong "new this period" signal, so it outranks any
// finite %; ties there fall to |delta| downstream.
const FROM_ZERO = Number.MAX_SAFE_INTEGER

function movementWeight(cmp) {
  return cmp.pct_change == null ? FROM_ZERO : Math.abs(cmp.pct_change)
}

// 1-dp display trim that mirrors ask.js's own (round to 1 dp, drop trailing
// zeros): 23.0769 → "23.1", 20.0 → "20". Kept local because ask.js's `trim` is
// private; matching it keeps a suggestion headline byte-identical to the delta
// chip the clicked answer renders.
function trim1(n) {
  return String(Math.round(Math.abs(n) * 10) / 10)
}

/**
 * Rank raw current/baseline pairs into ready-to-render suggestion chips.
 *
 * @param {Array<{metric:string,current:number,baseline:number}>} rawMovers
 * @param {object} [opts]
 * @param {number} [opts.limit=3]              max chips returned (clamped 1..7)
 * @param {string} [opts.windowLabel='vs last week']  chip subtext
 * @returns {Array<{
 *   metric, metric_label, question, direction, improved,
 *   pct_display, delta_display, headline, subtext
 * }>}  biggest-mover first; metrics with no data or no movement are dropped.
 */
function rankMovers(rawMovers, opts = {}) {
  const limit = Math.min(7, Math.max(1, Math.trunc(Number(opts.limit)) || 3))
  const windowLabel = opts.windowLabel || 'vs last week'

  const scored = []
  for (const m of Array.isArray(rawMovers) ? rawMovers : []) {
    const desc = METRICS[m.metric]
    if (!desc || !QUESTION[m.metric]) continue           // unknown/unsupported metric → skip
    const cur  = Number(m.current)  || 0
    const base = Number(m.baseline) || 0
    if (cur === 0 && base === 0) continue                // no data either period → nothing to say

    const cmp = computeComparison(cur, base, m.metric)
    if (cmp.direction === 'flat') continue               // didn't move → not a mover

    const word         = cmp.direction === 'up' ? 'up' : 'down'
    const pct_display   = cmp.pct_change == null ? null : trim1(cmp.pct_change) + '%'
    const delta_display = formatValue(Math.abs(cmp.delta), desc)
    scored.push({
      _weight:   movementWeight(cmp),
      _tiebreak: Math.abs(cmp.delta),
      metric:        m.metric,
      metric_label:  desc.label,
      question:      QUESTION[m.metric],
      direction:     cmp.direction,                      // 'up' | 'down'
      improved:      cmp.improved,                       // true | false | null
      pct_display,
      delta_display,
      // Prefer the relative % when defined; fall back to the absolute change for a
      // zero-baseline jump. Reads the same as the chip the clicked answer shows.
      headline:      `${desc.label} ${word} ${pct_display || delta_display}`,
      subtext:       windowLabel,
    })
  }

  scored.sort((a, b) => (b._weight - a._weight) || (b._tiebreak - a._tiebreak))
  return scored.slice(0, limit).map(({ _weight, _tiebreak, ...s }) => s)
}

module.exports = { rankMovers, QUESTION }
