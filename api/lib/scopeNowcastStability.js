'use strict'
// lib/scopeNowcastStability.js — intel-v14 D11 (step a): is the run's step-to-step RHYTHM
// consistent, or is it JUMPY?
//
// D3 (scopeNowcast) projects each trending metric forward at its AVERAGE step pace — a straight line.
// D10 (momentum) asked whether that pace is BENDING: a SYSTEMATIC early-vs-late trend (accelerating /
// decelerating / steady). But a run can hold a flat average pace AND a flat curvature while still
// lurching from one read to the next: a run of +1, +9, +1, +9 has the identical early-half and
// late-half mean — D10 reads it "steady" — yet no single next read is predictable from it. That
// step-to-step SCATTER, the non-systematic jitter that survives after pace (D3) and curvature (D10)
// are accounted for, is its own distinct reliability signal.
//
// It is also the ONLY reliability lens here that needs no track record. D4 (accuracy) and D5 (band)
// require ≥4 buffered cross-read backtests; D7 (corroboration) requires an independent `since`. D11 is
// intrinsic to the CURRENT run's own steps, so it speaks on a fresh session that has never been
// backtested — exactly when a consumer most needs to know whether to trust the single projected
// number or read it as a rough center.
//
// D11 measures the dispersion of the step magnitudes (in drift-free CENTS) relative to their mean —
// the coefficient of variation, CV = stdev/mean — and classifies the run:
//   • smooth   — steps are evenly sized (CV ≤ smoothMaxCv); the projected single number is on firm
//     footing;
//   • choppy   — steps lurch around (CV ≥ choppyMinCv); read the projection as a rough center, not a
//     precise target;
//   • variable — in between; the projection is reasonable but not pinpoint.
// It requires ≥3 steps (≥4 reads). With only 2 steps there is no scatter to speak of that is
// independent of the pace bend D10 already reports (the 2-step CV is a monotone function of D10's
// pace ratio), so D11 stays silent there and never merely re-states D10. CV is scale-invariant
// (dollars vs cents give the same ratio), so cents is purely an anti-drift basis — a knife-edge CV
// never wobbles on float re-summation noise.
//
// The "jumpiest" projection — the one with the HIGHEST CV — leads, because that is where the
// single-number projection is least trustworthy; it both sets the overall level and is the headline
// mover. Jitter is direction-NEUTRAL: a smooth climb and a smooth decline are equally well-grounded,
// a choppy gain and a choppy adverse move are equally hard to pin — so unlike D10 the note does not
// branch on polarity. It speaks to RELIABILITY, not to good/bad.
//
// Like every D4–D10 sibling this NEVER touches the number or the voice: it can only add a "stability"
// qualifier beside them. It does not mutate nowcast.headline, nowcast.voice, nowcast.coherence,
// nowcast.materiality, nowcast.momentum, nowcast.corroboration, or any projected value.
//
// Design properties (the same discipline as its D1–D10 siblings):
//   • PURE + leak-safe — the sole input is the ALREADY leak-safe projection set (metric ids + labels
//     + the run's own directions/polarity + its bare-number run reads). This module sees no clientId
//     and emits none; its output is metric labels + direction/polarity + level words + derived
//     dispersion ratios / step magnitudes (the same class scopeNowcast already exposes as paceCents)
//     + small counts — identical on the agency and client surfaces.
//   • Drift-free dispersion — step magnitudes are measured in integer cents via the shared toCents,
//     so a knife-edge CV never wobbles on float re-summation noise; the CV itself is scale-invariant.
//   • One polarity oracle — favorable/adverse is the SAME `improving` flag every lens computes; D11
//     carries it through unused-for-classification (jitter is direction-neutral) so a downstream
//     surface can still read it consistently.
//   • Additive + only ever a qualifier — emits a sibling cue; never mutates the voice or the number.
//   • Deterministic + fail-safe — no clock, no RNG, no DB; stable salience order (ties resolve to the
//     more salient projection); any malformed input degrades to { status:'none' } and never throws.

const { toCents } = require('./scopeFreshness')

const isNum = (v) => v != null && Number.isFinite(Number(v))
const cap = (s) => {
  const str = String(s == null ? '' : s)
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : str
}
const isDir = (d) => d === 'up' || d === 'down'
const mean = (arr) => arr.reduce((s, n) => s + n, 0) / arr.length

// The default CV bands. A run whose step magnitudes vary by ≤25% of their mean reads as "smooth"
// (the straight-line projection's single number is well-grounded); ≥60% reads as "choppy" (the run
// is jumpy, so the projected figure is a rough center, not a target); between the two is "variable".
// Both are overridable via opts for a future per-metric or per-tenant policy.
const DEFAULT_SMOOTH_MAX_CV = 0.25
const DEFAULT_CHOPPY_MIN_CV = 0.6

// Measure one projection's step dispersion from its run reads. Returns null when the run is not
// dispersion-measurable: fewer than 4 finite reads (need ≥3 steps for a scatter that is independent
// of D10's 2-step pace bend), any non-finite read, or a zero mean step (no defensible base for the
// ratio — cannot happen inside a real run, where every step is ≥1 cent, but guarded so a hand-built
// input degrades safely rather than dividing by zero). Otherwise returns the leak-safe descriptor.
const dispersionOf = (p, smoothMaxCv, choppyMinCv) => {
  const values = Array.isArray(p.values) ? p.values : null
  if (!values || values.length < 4) return null
  if (!values.every(isNum)) return null

  // step magnitudes across the run, in integer cents (drift-free).
  const mags = []
  for (let k = 1; k < values.length; k++) mags.push(Math.abs(toCents(values[k]) - toCents(values[k - 1])))

  const meanStep = mean(mags)
  if (!(meanStep > 0)) return null

  // population standard deviation (÷n) — deterministic, and the bands are calibrated to it. The CV is
  // the dispersion relative to the mean step, so it is scale-invariant and directly comparable across
  // metrics of wildly different magnitudes (revenue dollars vs a close-rate fraction).
  const variance = mean(mags.map((m) => (m - meanStep) * (m - meanStep)))
  const stdev = Math.sqrt(variance)
  const cv = stdev / meanStep
  const level = cv <= smoothMaxCv ? 'smooth' : cv >= choppyMinCv ? 'choppy' : 'variable'

  return {
    metric: String(p.metric),
    label: p.metric_label != null ? String(p.metric_label) : String(p.metric),
    direction: isDir(p.direction) ? p.direction : null,
    improving: p.improving === true ? true : p.improving === false ? false : null,
    level,
    cv,
    cvPct: cv * 100,
    meanStepCents: meanStep,
    stdevStepCents: stdev,
    steps: mags.length,
  }
}

// The honest one-line story for the cue. It names the jumpiest mover and what its rhythm implies for
// the straight-line projection — firm footing when smooth, a rough center when choppy. Direction-
// neutral by design (jitter is about reliability, not good/bad), and qualitative ("evenly sized" /
// "uneven") rather than a raw CV percentage a consumer could not interpret. The agency renders it
// as-is; the client surface softens only the peripheral pill label (in the UI), never this line.
function composeNote(s) {
  const subject = cap(s.label)
  if (s.level === 'smooth') {
    return `${subject}'s updates have been evenly sized — the run is steady underfoot, so the projected figure rests on firm footing.`
  }
  if (s.level === 'choppy') {
    return `${subject}'s updates have been uneven — the run is jumpy, so read the projected figure as a rough center, not a precise target.`
  }
  return `${subject}'s updates vary in size — the projection is reasonable but not pinpoint.`
}

// assessNowcastStability(nowcast, opts)
//   nowcast : a projectScopeTrend() result ({status:'projected', projections:[...]}).
//   opts    : { smoothMaxCv=0.25, choppyMinCv=0.6 } — the CV thresholds. If an override inverts them
//             (smoothMax ≥ choppyMin) both revert to the defaults, so banding is always sane.
// Returns { status, reason, level, smoothMaxCv, choppyMinCv, assessedCount, smoothCount,
//           variableCount, choppyCount, jumpiest, decisive, note, meta }.
//   status : 'none'     — no projection carries a dispersion-measurable run (≥4 finite reads);
//            'assessed' — ≥1 projection was measured.
//   level  : the jumpiest projection's level — 'smooth' | 'variable' | 'choppy' (status 'assessed'),
//            else 'indeterminate'.
//   jumpiest / decisive : the move with the highest CV (the least-trustworthy single projection); they
//            are the same move — the jumpiest run both sets the overall level and is the headline mover.
function assessNowcastStability(nowcast, opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  let smoothMaxCv = isNum(o.smoothMaxCv) && Number(o.smoothMaxCv) > 0 ? Number(o.smoothMaxCv) : DEFAULT_SMOOTH_MAX_CV
  let choppyMinCv = isNum(o.choppyMinCv) && Number(o.choppyMinCv) > 0 ? Number(o.choppyMinCv) : DEFAULT_CHOPPY_MIN_CV
  if (!(choppyMinCv > smoothMaxCv)) {
    smoothMaxCv = DEFAULT_SMOOTH_MAX_CV
    choppyMinCv = DEFAULT_CHOPPY_MIN_CV
  }

  const none = (reason) => ({
    status: 'none',
    reason,
    level: 'indeterminate',
    smoothMaxCv,
    choppyMinCv,
    assessedCount: 0,
    smoothCount: 0,
    variableCount: 0,
    choppyCount: 0,
    jumpiest: null,
    decisive: null,
    note: null,
    meta: { basis: 'step-dispersion' },
  })
  try {
    if (!nowcast || typeof nowcast !== 'object' || nowcast.status !== 'projected') return none('no-nowcast')
    const projections = Array.isArray(nowcast.projections) ? nowcast.projections : []

    // Measure every dispersion-bearing projection, preserving salience order and deduping by metric
    // id so a malformed double-entry can't double-count. Projections whose run is too short (<3 steps)
    // / has a non-finite read / has a zero mean step carry no dispersion and are excluded.
    const moves = []
    const seen = new Set()
    for (const p of projections) {
      if (!p || typeof p !== 'object' || p.metric == null) continue
      const id = String(p.metric)
      if (seen.has(id)) continue
      const s = dispersionOf(p, smoothMaxCv, choppyMinCv)
      if (!s) continue
      seen.add(id)
      moves.push(s)
    }

    const assessedCount = moves.length
    if (assessedCount === 0) return none('no-dispersion')

    // the jumpiest run leads: highest CV; strict > keeps the FIRST (more salient) on a tie. This is
    // where a single-number projection is least trustworthy, so it both sets the overall level and is
    // the headline mover — regardless of polarity (jitter is direction-neutral).
    let decisive = null
    for (const m of moves) if (!decisive || m.cv > decisive.cv) decisive = m

    const smoothCount = moves.reduce((n, m) => n + (m.level === 'smooth' ? 1 : 0), 0)
    const variableCount = moves.reduce((n, m) => n + (m.level === 'variable' ? 1 : 0), 0)
    const choppyCount = moves.reduce((n, m) => n + (m.level === 'choppy' ? 1 : 0), 0)

    return {
      status: 'assessed',
      reason: null,
      level: decisive.level,
      smoothMaxCv,
      choppyMinCv,
      assessedCount,
      smoothCount,
      variableCount,
      choppyCount,
      jumpiest: decisive,
      decisive,
      note: composeNote(decisive),
      meta: { basis: 'step-dispersion' },
    }
  } catch {
    return none('error')
  }
}

module.exports = { assessNowcastStability }
