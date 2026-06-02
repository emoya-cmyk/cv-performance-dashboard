'use strict'

// ============================================================
// lib/pulseReliability.js — the Daily Pulse's self-grading reliability score.
//
// THE GAP THIS CLOSES
// -------------------
// lib/dayPulse fires an intra-week signal the day a client's trailing-week level
// slides out of its own band. That is the early warning — but raw, every firing
// looks equally trustworthy. Some clients' metrics genuinely shift and the
// signal sticks; others swing week to week and every firing is half noise. The
// engine has no way to tell the surface "this client's leads pulse has a good
// track record — act on it" versus "this one flickers — read it with care."
// This module is that missing judgement: it grades the sensor's OWN past firings
// against this client's OWN history and distils a single learned trust score —
// no human tuning, no model, just the sensor watching how often it was right
// before. It is the "self-improving" loop the dashboard's intelligence layer
// needs: the early-warning organ now reports its own confidence.
//
// HOW IT GRADES — REPLAY + PERSISTENCE
// ------------------------------------
// Reliability here means PERSISTENCE: a real shift is still visible a few days
// later; a one-off blip has rolled off the trailing window by then. So we replay
// dayPulse at every historical end-position t (the verdict "as of day t"), and
// for each position that FIRED (status:'signal') we look ahead one HORIZON
// (≈ half a window, ⌈W/2⌉ = 4 days for W=7) and ask: is the SAME-DIRECTION signal
// still firing at t+horizon? Yes ⇒ CORROBORATED, the firing held up. No (it has
// reverted to normal, or flipped direction) ⇒ REVERTED, the firing was noise.
//   reliability = corroborated / fires   (a firing's own batting average)
// Same-direction is required so a drop "corroborated" by a later spike doesn't
// count — that's a different event, not persistence of the first.
//
// HONEST BY ABSTENTION — MATURITY + MINIMUM FIRINGS
// -------------------------------------------------
// A firing in the last `horizon` days has no future yet to be graded against, so
// it is EXCLUDED from the denominator — we never penalize the sensor for a fresh
// firing we simply haven't had time to judge (reliability reflects only MATURED
// firings, a true track record). And a sensor that has fired fewer than
// `minFires` (default 3) gradeable times has too thin a record to trust a ratio
// from ⇒ status:'insufficient', reliability:null — abstain, never guess. Same
// discipline as dayPulse's 'insufficient' and baselines' minN.
//
// PURE: a dense daily numeric array in (the SAME series dayPulse/getClientPulse
// already build for one flow metric), a grade out. No DB, no clock, no network,
// no LLM, no mutation — it only REPLAYS the existing pure dayPulse over prefixes
// of the array, so there is one definition of "a firing" across the whole system
// and this score can never drift from the live sensor. Reasons in window
// POSITIONS only, exactly like dayPulse, so it stays trivially testable on plain
// number arrays. The caller threads the metric's polarity (adverseWhen) straight
// through so the replayed verdicts are byte-identical to the ones the engine
// raised live.
// ============================================================

const { dayPulse, DEFAULT_WINDOW, DEFAULT_MIN_WINDOWS } = require('./dayPulse')

// Minimum MATURED firings before a reliability ratio is trustworthy. Below this
// the record is too thin to grade — abstain (mirrors dayPulse's minWindows and
// baselines' minN: honesty by abstention, never a guess off one or two points).
const DEFAULT_MIN_FIRES = 3

// Look-ahead, in days, used to judge whether a firing held up. Half a window
// (⌈W/2⌉ = 4 for W=7): far enough that a single-day blip has rolled off the
// trailing sum, near enough that a genuine multi-day shift is still in band-
// breaking territory. Derived from the window so it scales with it.
function defaultHorizon(w) {
  return Math.max(1, Math.ceil(w / 2))
}

// reliabilityLabel(r) — the plain-language band for a reliability ratio in [0,1].
// reliable ≥ 0.70 · mixed 0.40–0.69 · noisy < 0.40 · null (un-graded) → null.
// One source of truth for the word the engine attaches and both UIs render.
function reliabilityLabel(r) {
  if (r == null || !Number.isFinite(r)) return null
  if (r >= 0.7) return 'reliable'
  if (r >= 0.4) return 'mixed'
  return 'noisy'
}

/**
 * pulseReliability(values, opts)
 *   values : a dense daily numeric series for ONE flow metric, oldest→newest —
 *            the SAME shape dayPulse consumes (missing days zero-filled by the
 *            caller). The score is computed by replaying dayPulse over its
 *            prefixes, so it judges exactly the firings the live sensor raises.
 *   opts   : { window=7, minWindows=3, warn, crit, adverseWhen, horizon, minFires=3 }
 *            window / minWindows / warn / crit / adverseWhen are forwarded
 *            VERBATIM to dayPulse so each replayed verdict matches the live one;
 *            horizon overrides the ⌈window/2⌉ look-ahead; minFires sets the
 *            abstention floor on matured firings.
 *
 * Returns a grade (never throws):
 *   { status:'graded'|'insufficient', window, horizon,
 *     fires, corroborated, reverts, reliability, label,
 *     n_positions, min_fires, reason }
 *   • 'insufficient' — the sensor never had enough history to judge at any
 *      position (reason 'insufficient_history'), or it judged but fired fewer
 *      than minFires matured times (reason 'insufficient_fires'); reliability:null.
 *   • 'graded'       — reliability = corroborated / fires ∈ [0,1], label set.
 *   Invariants: corroborated + reverts === fires; fires counts ONLY positions
 *   whose t+horizon falls within the series (matured); n_positions is the count
 *   of replay positions that produced a definite verdict (signal or normal).
 */
function pulseReliability(values, opts = {}) {
  const w = Number.isInteger(opts.window) && opts.window > 0 ? opts.window : DEFAULT_WINDOW
  const minW = Number.isInteger(opts.minWindows) && opts.minWindows > 0 ? opts.minWindows : DEFAULT_MIN_WINDOWS
  const minFires = Number.isInteger(opts.minFires) && opts.minFires > 0 ? opts.minFires : DEFAULT_MIN_FIRES
  const horizon = Number.isInteger(opts.horizon) && opts.horizon > 0 ? opts.horizon : defaultHorizon(w)
  const xs = Array.isArray(values) ? values : []
  const L = xs.length - 1

  // Forward EXACTLY dayPulse's knobs so each replayed verdict is the one the live
  // sensor would have raised on that day — the grade judges real firings, not a
  // re-parameterized shadow of them.
  const pulseOpts = { window: w, minWindows: minW, warn: opts.warn, crit: opts.crit, adverseWhen: opts.adverseWhen }

  // Replay the verdict "as of day t" at every position once (O(n²) on a ≤9-week
  // series — trivial), then grade in a second pass. Caching the verdicts avoids
  // recomputing the same prefix for both the firing check and its look-ahead.
  const verdicts = new Array(xs.length)
  let nPositions = 0
  for (let t = 0; t <= L; t++) {
    const v = dayPulse(xs.slice(0, t + 1), pulseOpts)
    verdicts[t] = v
    if (v.status === 'signal' || v.status === 'normal') nPositions++
  }

  // Grade every MATURED firing: a position that fired AND whose t+horizon still
  // falls inside the series. Counting BEFORE the abstention checks lets every
  // return path report the real tally — "it fired twice, I need three" is more
  // honest than a flat zero, and it makes corroborated + reverts === fires a
  // universal invariant rather than one that only holds on the graded path.
  let fires = 0
  let corroborated = 0
  let reverts = 0
  for (let t = 0; t <= L; t++) {
    const v = verdicts[t]
    if (v.status !== 'signal') continue
    const ahead = t + horizon
    if (ahead > L) continue              // no matured future yet → not gradeable
    const future = verdicts[ahead]
    fires++
    // Held up only if the SAME-direction signal is still firing a horizon later;
    // a revert to 'normal' OR a flip to the opposite direction both count against.
    if (future.status === 'signal' && future.direction === v.direction) corroborated++
    else reverts++
  }

  // The bookkeeping every return path carries verbatim, so a consumer always
  // sees how thin (or thick) the record is — even when we ultimately abstain.
  const counts = { window: w, horizon, fires, corroborated, reverts, n_positions: nPositions, min_fires: minFires }

  // Abstain — no definite verdict anywhere (never enough history to judge), or it
  // judged but fired too few MATURED times to trust a ratio from. reliability:null.
  if (nPositions === 0) return { status: 'insufficient', ...counts, reliability: null, label: null, reason: 'insufficient_history' }
  if (fires < minFires) return { status: 'insufficient', ...counts, reliability: null, label: null, reason: 'insufficient_fires' }

  const reliability = corroborated / fires
  return { status: 'graded', ...counts, reliability, label: reliabilityLabel(reliability), reason: 'graded' }
}

// One grounded sentence for a graded reliability — deterministic, no LLM. Every
// figure (the matured firing count, the % that held up) is copied straight off
// the grade, so the sentence can never disagree with the score. Returns '' for an
// un-graded / missing grade (nothing trustworthy to say), exactly as
// narrateDayPulse falls silent on a non-signal.
//   agency reliable : "Leads alerts for this client have held up 9 of 10 times recently (~90%) — a reliable signal."
//   agency noisy    : "Spend alerts for this client have held up 2 of 6 times recently (~33%) — a noisy signal, read it with care."
//   client          : only REINFORCES a reliable signal ("This has been a consistent signal lately."); never volunteers
//                     "noisy" to the client — a soft, confidence-only note (the mixed/noisy case stays silent for them).
function narratePulseReliability(rel, opts = {}) {
  if (!rel || rel.status !== 'graded' || rel.reliability == null) return ''
  const audience = opts.audience === 'client' ? 'client' : 'agency'
  const label = opts.label || 'Activity'
  const pct = Math.round(rel.reliability * 100)

  if (audience === 'client') {
    return rel.label === 'reliable' ? 'This has been a consistent signal lately.' : ''
  }

  const phrase =
    rel.label === 'reliable' ? 'a reliable signal' :
    rel.label === 'noisy'    ? 'a noisy signal, read it with care' :
                               'a mixed signal'
  return `${label} alerts for this client have held up ${rel.corroborated} of ${rel.fires} times recently (~${pct}%) — ${phrase}.`
}

module.exports = {
  pulseReliability,
  narratePulseReliability,
  reliabilityLabel,
  DEFAULT_MIN_FIRES,
}
