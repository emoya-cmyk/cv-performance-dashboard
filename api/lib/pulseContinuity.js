'use strict'

// ============================================================
// lib/pulseContinuity.js — intel-v7 (8): the morning's MEMORY.
//
// THE GAP THIS CLOSES
// -------------------
// Layer 7 ([[pulseBriefing]]) collapses the whole self-grading pulse into one
// sentence: "if you do one thing today, do this." But that sentence is STATELESS —
// it is recomputed from scratch every morning with no idea what it said yesterday.
// So the same metric can headline the briefing three mornings running and each day
// it reads as if discovered fresh. A real analyst does not reset overnight: the
// difference between "leads are soft this morning" and "leads have been soft for a
// THIRD straight morning, and it's getting worse" is the difference between a
// number and a narrative — and it is exactly the line that makes an operator stop
// scrolling. Conversely, "yesterday's revenue alarm has already cleared" is a win
// worth saying out loud, and today's stateless briefing throws it away. This layer
// gives the briefing a memory: for each flow metric it asks, across the last few
// mornings, is this alarm NEW, has it PERSISTED (and for how many mornings), is it
// ESCALATING or EASING, or did it just RESOLVE. Synthesis with continuity — no new
// sensor, no new number, only the same pulse remembered across days.
//
// WHY PREFIX-REPLAY, NOT A STORED LOG
// -----------------------------------
// "What did the pulse say yesterday?" needs no database. dayPulse reasons purely in
// window POSITIONS, so the pulse "as of N mornings ago" is just dayPulse over the
// daily series TRUNCATED at that morning: values.slice(0, L - back + 1). Each such
// prefix sees only days up to that morning — look-ahead-proof by construction, the
// identical discipline [[pulseAccuracy]] uses to replay the early call over prefixes.
// Because the memory is reconstructed from the very same daily facts the live sensor
// reads, the remembered history can never drift from what the sensor would have
// actually shown — there is no second source of truth to fall out of sync. (No clock
// either: "morning" is just the last index, so the replay is deterministic and the
// tests run on plain number arrays.)
//
// ONE DEFINITION OF "FIRING", HONEST ABOUT WHAT IT CAN'T SEE
// ----------------------------------------------------------
// A morning is "firing" iff that morning's dayPulse is an ADVERSE signal — the same
// adverse flag the live triage acts on, forwarded via the same adverseWhen polarity.
// "Not firing" deliberately folds together a normal morning AND an insufficient one:
// both mean "no adverse alarm was standing as of that morning," which is the truth.
// We never fabricate a history the sensor could not yet see — so on a young account
// the first morning it has the history to fire reads honestly as 'new', not as a
// silent continuation of days it could not have judged.
//
// PURE + TOTAL: dense daily numeric arrays in, descriptors out. No DB, no clock, no
// network, no LLM, no mutation; never throws; tolerant of empty / garbage input
// (too little history → a calm 'quiet' descriptor, never a guess). The caller (the
// engine / a read route) densifies each flow metric's daily fact_metric series and
// attaches the calendar dates for display, exactly as it already does for dayPulse.
// ============================================================

const { dayPulse, DEFAULT_WINDOW, DEFAULT_MIN_WINDOWS } = require('./dayPulse')

// How many trailing mornings of memory to reconstruct. A week is the natural horizon
// — "has this been the story all week?" — and keeps the streak honest about "this
// week" without claiming a history older than the briefing's own frame.
const DEFAULT_MEMORY = 7
// Trend deadband, in percentage-points of delta_pct: today's gap from baseline must
// move more than this from the prior morning's gap to count as worsening / easing,
// so ordinary daily wobble does not read as a trend.
const DEFAULT_DEADBAND_PCT = 10

function posInt(v, dflt) {
  return Number.isInteger(v) && v > 0 ? v : dflt
}
function finiteOrNull(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// ordinal(3) → "3rd". For the streak phrasing ("3rd morning running").
function ordinal(n) {
  const j = n % 10
  const k = n % 100
  if (j === 1 && k !== 11) return `${n}st`
  if (j === 2 && k !== 12) return `${n}nd`
  if (j === 3 && k !== 13) return `${n}rd`
  return `${n}th`
}

function plural(n, one, many) { return n === 1 ? one : many }
function lc(label) { return String(label == null ? 'this metric' : label).toLowerCase() }

/**
 * metricContinuity(values, opts)
 *   values : a dense daily numeric series for ONE flow metric, oldest→newest (the
 *            SAME shape dayPulse/pulseAccuracy consume; missing days zero-filled by
 *            the caller). The memory is reconstructed by replaying dayPulse over its
 *            morning-ending prefixes.
 *   opts   : { window=7, minWindows=3, warn, crit, adverseWhen, memory=7,
 *              deadbandPct=10 }
 *            window / minWindows / warn / crit / adverseWhen forward VERBATIM to
 *            dayPulse so each remembered morning is byte-identical to what the live
 *            sensor would have shown; memory sets how many trailing mornings to
 *            reconstruct; deadbandPct sets the worsening/easing trend deadband.
 *
 * Returns a descriptor (never throws):
 *   { status:'new'|'persisting'|'resolved'|'quiet',
 *     firing_today, prev_firing, streak, streak_capped, since_back, trend,
 *     delta_today, delta_prev, memory_used, window, reason }
 *   • status  — 'new' (firing today, clear the prior morning) · 'persisting' (firing
 *     today AND the prior morning) · 'resolved' (clear today, was firing yesterday —
 *     a win) · 'quiet' (clear today and yesterday);
 *   • streak  — consecutive adverse mornings ending today (0 when clear today);
 *   • streak_capped — true when the streak fills the whole memory window AND earlier
 *     mornings exist (the true run may be longer → surfaces say "at least Nth");
 *   • since_back — mornings-ago the current run began (streak-1; null when clear);
 *   • trend   — 'worsening'|'easing'|'steady' from |delta today| vs |delta prior
 *     morning| past the deadband (null unless firing today AND the prior morning,
 *     both deltas finite);
 *   • delta_today / delta_prev — the % gaps off each morning's own verdict (null when
 *     that morning's baseline median was 0, the divide dayPulse already refuses).
 */
function metricContinuity(values, opts = {}) {
  const w      = posInt(opts.window, DEFAULT_WINDOW)
  const minW   = posInt(opts.minWindows, DEFAULT_MIN_WINDOWS)
  const memory = posInt(opts.memory, DEFAULT_MEMORY)
  const dead   = Number.isFinite(opts.deadbandPct) && opts.deadbandPct >= 0 ? opts.deadbandPct : DEFAULT_DEADBAND_PCT
  const xs     = Array.isArray(values) ? values : []
  const L      = xs.length - 1

  // Forward dayPulse's knobs verbatim so each remembered morning matches the live
  // sensor exactly — one definition of "unusual" across detect, audit, and memory.
  const dailyOpts = { window: w, minWindows: minW, warn: opts.warn, crit: opts.crit, adverseWhen: opts.adverseWhen }

  // Replay the SAME dayPulse as-of each of the last `memory` mornings: prefix ending
  // at L (today), L-1 (yesterday), … Each prefix is look-ahead-proof. v[0] = today.
  const verdicts = []
  for (let back = 0; back < memory; back++) {
    const end = L - back
    if (end < 0) break
    verdicts.push(dayPulse(xs.slice(0, end + 1), dailyOpts))
  }

  // "Firing" = an ADVERSE signal that morning. Not-firing folds normal AND
  // insufficient together — both are an honest "no adverse alarm stood that morning."
  const firing = verdicts.map((v) => v.status === 'signal' && v.adverse === true)
  const firingToday = firing.length > 0 && firing[0]
  const prevExists  = firing.length > 1
  const prevFiring  = prevExists && firing[1]

  // streak — consecutive firing mornings ending today (0 when clear today).
  let streak = 0
  if (firingToday) { for (let k = 0; k < firing.length && firing[k]; k++) streak++ }
  // capped when the run fills the whole sampled window AND an earlier morning exists
  // beyond it (so the real streak may be longer than we sampled).
  const streak_capped = firingToday && streak === verdicts.length && (L - verdicts.length + 1) > 0

  const delta_today = verdicts.length ? finiteOrNull(verdicts[0].delta_pct) : null
  const delta_prev  = prevExists ? finiteOrNull(verdicts[1].delta_pct) : null

  // trend — only when firing today AND the prior morning, both gaps finite. Compares
  // DISTANCE from baseline (magnitude), so "worsening" means further from normal.
  let trend = null
  if (firingToday && prevFiring && delta_today != null && delta_prev != null) {
    const diff = Math.abs(delta_today) - Math.abs(delta_prev)
    trend = diff > dead ? 'worsening' : diff < -dead ? 'easing' : 'steady'
  }

  let status
  if (!firingToday) status = prevFiring ? 'resolved' : 'quiet'
  else status = prevFiring ? 'persisting' : 'new'

  const reason =
    status === 'new' ? 'first_morning' :
    status === 'persisting' ? 'continuing' :
    status === 'resolved' ? 'cleared' : 'no_alarm'

  return {
    status,
    firing_today: firingToday,
    prev_firing: prevFiring,
    streak,
    streak_capped,
    since_back: firingToday ? streak - 1 : null,
    trend,
    delta_today,
    delta_prev,
    memory_used: verdicts.length,
    window: w,
    reason,
  }
}

/**
 * summarizeContinuity(items, opts)
 *   items : [{ metric, label, lane, is_focus, continuity }] — one per flow metric the
 *           caller reconstructed memory for (today's adverse signals AND any that just
 *           cleared, so 'resolved' wins are visible). `continuity` is a
 *           metricContinuity descriptor; `is_focus` marks the briefing's focus metric.
 *   opts  : { resolvedCap=3 } — most resolved wins to carry.
 *
 * Returns a machinery-free memory the briefing folds in (no z / baseline / reliability
 * / accuracy / tuning ever — safe for the client egress):
 *   { focus:{ metric,label,status,streak,streak_capped,since_back,trend }|null,
 *     resolved:[{ metric,label }], new_count, persisting_count, escalating_count }
 *   • focus — the focus metric's continuity, distilled to client-visible fields;
 *   • resolved — metrics that were firing yesterday and are clear today (wins);
 *   • *_count — across metrics firing today: brand-new, persisting, and of those
 *     persisting, how many are worsening (escalating).
 */
function summarizeContinuity(items, opts = {}) {
  const rows = Array.isArray(items) ? items : []
  const cap  = posInt(opts.resolvedCap, 3)

  let new_count = 0
  let persisting_count = 0
  let escalating_count = 0
  const resolved = []
  let focus = null

  for (const it of rows) {
    if (!it || !it.continuity) continue
    const c = it.continuity
    if (c.firing_today) {
      if (c.status === 'new') new_count++
      else if (c.status === 'persisting') {
        persisting_count++
        if (c.trend === 'worsening') escalating_count++
      }
    } else if (c.status === 'resolved') {
      if (resolved.length < cap) resolved.push({ metric: it.metric, label: it.label })
    }
    if (it.is_focus && c.firing_today && !focus) {
      focus = {
        metric: it.metric,
        label: it.label,
        status: c.status,
        streak: c.streak,
        streak_capped: c.streak_capped,
        since_back: c.since_back,
        trend: c.trend,
      }
    }
  }

  return { focus, resolved, new_count, persisting_count, escalating_count }
}

// narrateContinuity(cont, opts) — a short SUFFIX clause to splice onto the briefing
// headline, grounded entirely in the descriptor. Returns '' when there is nothing to
// add (not firing today, or no descriptor). Audience-split like the sibling narrators.
//   agency new        : "New this morning."
//   agency persisting : "3rd morning running — and worsening." / "…, though easing." / "3rd morning running."
//   client new        : "This is new this morning."
//   client persisting : "We've been tracking this for 3 days, and it hasn't turned around yet."
function narrateContinuity(cont, opts = {}) {
  if (!cont || !cont.firing_today) return ''
  const audience = opts.audience === 'client' ? 'client' : 'agency'
  const n = cont.streak
  const cap = cont.streak_capped ? 'at least ' : ''

  if (cont.status === 'new') {
    return audience === 'client' ? 'This is new this morning.' : 'New this morning.'
  }

  // persisting
  if (audience === 'client') {
    const days = `${cap}${n} ${plural(n, 'day', 'days')}`
    if (cont.trend === 'worsening') return `We've been tracking this for ${days}, and it hasn't turned around yet.`
    if (cont.trend === 'easing')    return `We've been tracking this for ${days} — it's starting to settle.`
    return `We've been tracking this for ${days} now.`
  }
  const run = `${cap}${ordinal(n)} morning running`
  if (cont.trend === 'worsening') return `${run} — and worsening.`
  if (cont.trend === 'easing')    return `${run}, though easing.`
  return `${run}.`
}

// narrateResolved(resolved, opts) — one grounded sentence celebrating alarms that
// cleared overnight. '' when none. Agency lists the metrics; client stays warm and
// names its own metric (no peer names ever).
//   agency : "Resolved since yesterday: leads, revenue."
//   client : "Good news — your revenue alert from yesterday has settled back into your normal range."
function narrateResolved(resolved, opts = {}) {
  const list = Array.isArray(resolved) ? resolved.filter(Boolean) : []
  if (!list.length) return ''
  const audience = opts.audience === 'client' ? 'client' : 'agency'

  if (audience === 'client') {
    if (list.length === 1) {
      return `Good news — your ${lc(list[0].label)} alert from yesterday has settled back into your normal range.`
    }
    return `Good news — ${list.length} of yesterday's alerts have already settled back to normal.`
  }
  const labels = list.map((r) => lc(r.label)).join(', ')
  return `Resolved since yesterday: ${labels}.`
}

module.exports = {
  metricContinuity,
  summarizeContinuity,
  narrateContinuity,
  narrateResolved,
  ordinal,
  DEFAULT_MEMORY,
  DEFAULT_DEADBAND_PCT,
}
