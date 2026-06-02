'use strict'

// ============================================================
// lib/pacingAnswer.js — the grounded "are we on track?" answer for the Ask box.
//
// The Ask box can already answer the PAST ("what WAS revenue last week"), the WHO
// (contribution.js), the WHY (ratioAttribution.js), and — since intel-v6 (7) — the
// FUTURE ("what WILL it be", forecastAnswer.js). The question an owner actually asks
// before any of those is the simplest one of all: "are we on track to hit our
// number?" The machinery to answer it honestly has existed since intel-v4 (6):
// pacing.js already projects month-end by plain linear run-rate against the human-set
// monthly goal and bands the result (ahead / on_track / behind / at_risk), with an
// 'early' guard that withholds the alarm while the month is too young and a 'none'
// no-op when no goal is set. This module is the missing adapter that turns that same
// verdict into a plain-language sentence for the chat surface.
//
// It is the goal-side twin of forecastAnswer.js: forecastAnswer wraps forecast.js
// (the trend projection) for "what's the number ahead?"; this wraps classifyPacing
// (the run-rate-vs-target verdict) for "do we make the number we committed to?".
// Both keep their pure compute module untouched — forecast.js / pacing.js stay shared
// by the health and roster layers — and add only the metric-first entry point plus a
// grounded narrator, so the whole Ask layer speaks one language about one thing.
//
// ACCURATE BY CONSTRUCTION — no LLM arithmetic anywhere. The projection, attainment,
// shortfall and catch-up multiple are read straight off classifyPacing; the narrator
// only copies those numbers into a sentence via the caller's formatter (grounded
// exactly like narrateForecast / narrateRatio / narrateContribution). HONEST BY
// CONSTRUCTION — classifyPacing's own status gate carries straight through: too early
// in the month → 'early' (numbers reported, alarm withheld); no goal set → 'none' (a
// quiet "nothing to pace against") — never a false-precision number dressed up as a
// call on a month that has barely begun.
//
// LEAK-SAFE: a single (client, metric) verdict is computed from that client's own
// actual-vs-target alone and names no other tenant — so one pacing answer is equally
// safe on the agency Intelligence page and on a client's /my-dashboard, exactly like
// the per-client verdict pacing.js already feeds the health badge. Only rankPacing's
// ROSTER (who will miss, worst-first) is agency-only, and that stays in pacing.js.
//
// PURE: facts in, verdict + sentence out. No DB, no clock (the caller passes the day
// counts — the engine supplies the real date, tests supply fixed ones), no network,
// no LLM, no mutation of inputs (matching pacing.js / forecastAnswer.js). The caller
// (ask.js) resolves the goal + month-to-date actual + day counts and passes the
// display formatter + label, so this module never reaches back into ask.js.
// ============================================================

const { classifyPacing } = require('./pacing')

/**
 * pacingAnswer(metric, facts, opts)
 *   metric : the metric key being paced ('revenue' | 'leads' | 'jobs'; echoed, not used to compute)
 *   facts  : { target, actual, daysElapsed, daysInMonth } — the month's goal, the
 *            month-to-date total, and the day counts (caller-derived from the real date)
 *   opts   : { minElapsed } — threads straight into classifyPacing (the early-month guard)
 *
 * A thin, metric-first adapter over classifyPacing, giving the Ask path the same
 * shape as forecastAnswer(metric, series, opts). Returns the full classifyPacing
 * verdict verbatim (never null, never throws): for missing/garbage facts that is a
 * quiet status:'none' no-op, which narratePacing renders as "no goal set yet".
 */
function pacingAnswer(metric, facts = {}, opts = {}) {
  const f = facts && typeof facts === 'object' ? facts : {}
  return classifyPacing(
    {
      metric,
      target:      f.target,
      actual:      f.actual,
      daysElapsed: f.daysElapsed,
      daysInMonth: f.daysInMonth,
    },
    opts,
  )
}

// One grounded sentence — deterministic, no LLM. Every metric figure is copied from
// the verdict via the caller's formatter `fmt`; the attainment / elapsed percentages
// and the catch-up multiple are derived ratios rendered literally. `label` + `fmt`
// come from the caller (ask.js METRICS) so this module never cycles back into ask.js.
//   ahead    : "Revenue is pacing ahead of goal — on track for ~$60k against a $50k goal (120% of target)."
//   on_track : "Revenue is on track — pacing to ~$48k against the $50k goal (96% of target)."
//   behind   : "Leads is behind pace — pacing to ~42 against a 50 goal (84% of target, about 8 short).
//               To still hit it you'd need about 1.29× your current pace."
//   at_risk  : "Leads is at risk of missing goal — pacing to ~30 against a 50 goal (60% of target, about 20 short).
//               To still hit it you'd need about 2× your current pace."
//   early    : "Only 10% of the month in — too early to call leads pacing. So far 2 toward a 50 goal."
//   none     : "No leads goal is set for this month, so there's nothing to pace against yet."
function narratePacing(verdict, opts = {}) {
  if (!verdict) return ''
  const label   = opts.label || verdict.metric || 'This metric'
  const labelLC = String(label).toLowerCase()
  const fmt     = typeof opts.fmt === 'function' ? opts.fmt : (x) => String(x)
  const pct     = verdict.attainment != null ? Math.round(verdict.attainment * 100) : null

  switch (verdict.status) {
    case 'none': {
      if (verdict.target == null) {
        return `No ${labelLC} goal is set for this month, so there's nothing to pace against yet.`
      }
      // a goal exists but the month is degenerate (no elapsed days) — honest, rare
      return `A ${labelLC} goal of ${fmt(verdict.target)} is set, but there isn't enough of the month yet to pace it.`
    }
    case 'early': {
      const share = verdict.confidence != null ? verdict.confidence : verdict.elapsed
      const pctElapsed = Math.round((share || 0) * 100)
      return (
        `Only ${pctElapsed}% of the month in — too early to call ${labelLC} pacing. ` +
        `So far ${fmt(verdict.actual)} toward a ${fmt(verdict.target)} goal.`
      )
    }
    case 'ahead':
      return (
        `${label} is pacing ahead of goal — on track for ~${fmt(verdict.projected)} ` +
        `against a ${fmt(verdict.target)} goal (${pct}% of target).`
      )
    case 'on_track':
      return (
        `${label} is on track — pacing to ~${fmt(verdict.projected)} ` +
        `against the ${fmt(verdict.target)} goal (${pct}% of target).`
      )
    case 'behind':
    case 'at_risk': {
      const lead = verdict.status === 'at_risk' ? `${label} is at risk of missing goal` : `${label} is behind pace`
      let s =
        `${lead} — pacing to ~${fmt(verdict.projected)} against a ${fmt(verdict.target)} goal ` +
        `(${pct}% of target, about ${fmt(verdict.shortfall)} short).`
      if (verdict.catchup != null) {
        s += ` To still hit it you'd need about ${verdict.catchup}× your current pace.`
      } else if (verdict.days_remaining === 0) {
        s += ` The month is closed, so that gap is now final.`
      }
      return s
    }
    default:
      return ''
  }
}

module.exports = { pacingAnswer, narratePacing }
