'use strict'
// lib/scopeNowcastMomentum.js — intel-v14 D10 (step a): is the pace that produced the
// projection still in force, or is it BENDING?
//
// D3 (scopeNowcast) projects each trending metric forward at its AVERAGE step pace — a straight
// line. That is the honest default, but a straight line is blind to CURVATURE. Two runs with the
// identical average pace tell opposite stories:
//   • a climb whose steps keep GROWING (accelerating) — a linear projection at the average pace
//     UNDERSTATES where the next read lands;
//   • a climb whose steps keep SHRINKING (decelerating / flattening) — the same linear projection
//     OVERSTATES it, because the run is running out of steam.
// D8 (coherence) read the projection vector's POLARITY (do the metrics agree); D9 (materiality)
// read its MAGNITUDE (is the move big enough to matter). D10 reads its CURVATURE: is the pace that
// justified the straight line still being delivered, or has the most recent stretch of the run
// bent away from it? That speaks directly to whether the projected NUMBER can be trusted at face
// value or should be read as a floor (accelerating) / ceiling (decelerating).
//
// The signal is already in hand: every projection carries `values` — the run's read sequence
// (oldest → newest, all finite, no gaps; scopeTrend breaks a run on a gap, a flat sub-cent step, or
// a reversal, so within a run every step is ≥1 cent and same-signed). D10 measures the step
// magnitudes in CENTS (drift-free, scale-invariant for the ratio) and compares an EARLY-half pace
// to a LATE-half pace:
//   • accelerating — the late pace is materially FASTER than the early pace (ratio ≥ 1 + band);
//   • decelerating — the late pace is materially SLOWER (ratio ≤ 1 − band);
//   • steady       — the pace held inside the band, so the straight line is well-founded.
// The "decisive" projection is the one whose pace bent the MOST (largest |pace change|), because
// that is where a linear projection is most at risk of being wrong — regardless of polarity. The
// note then frames that bend honestly by polarity: an accelerating ADVERSE move means the
// projection may understate the damage; a flattening GAIN means it may overstate the upside.
//
// Like every D4–D9 sibling this NEVER touches the number or the voice: it can only add a "momentum"
// qualifier beside them. It does not mutate nowcast.headline, nowcast.voice, nowcast.coherence,
// nowcast.materiality, nowcast.corroboration, or any projected value.
//
// Design properties (the same discipline as its D1–D9 siblings):
//   • PURE + leak-safe — the sole input is the ALREADY leak-safe projection set (metric ids +
//     labels + the run's own directions/polarity + its bare-number run reads). This module sees no
//     clientId and emits none; its output is metric labels + direction/polarity + shape words +
//     derived pace ratios/step magnitudes (the same class scopeNowcast already exposes as paceCents)
//     + small counts — identical on the agency and client surfaces.
//   • Drift-free curvature — step magnitudes are measured in integer cents via the shared toCents,
//     so a knife-edge ratio never wobbles on float re-summation noise; the ratio itself is
//     scale-invariant (dollars vs cents give the same ratio), so cents is purely an anti-drift basis.
//   • One polarity oracle — favorable/adverse is the SAME `improving` flag every lens computes, so
//     "accelerating adverse move" can never be defined inconsistently across metrics.
//   • Additive + only ever a qualifier — emits a sibling cue; never mutates the voice or the number.
//   • Deterministic + fail-safe — no clock, no RNG, no DB; stable salience order (ties resolve to
//     the more salient projection); any malformed input degrades to { status:'none' } and never throws.

const { toCents } = require('./scopeFreshness')

const isNum = (v) => v != null && Number.isFinite(Number(v))
const cap = (s) => {
  const str = String(s == null ? '' : s)
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : str
}
const isDir = (d) => d === 'up' || d === 'down'
const mean = (arr) => arr.reduce((s, n) => s + n, 0) / arr.length

// The default "steady" half-band, in PERCENT of the early pace. A late pace within ±20% of the
// early pace is treated as the same pace — the run is holding its slope and the straight-line
// projection is well-founded. Beyond the band in either direction the run is bending. Overridable
// via opts.steadyBandPct for a future per-metric or per-tenant policy.
const DEFAULT_STEADY_BAND_PCT = 20

// Measure one projection's curvature from its run reads. Returns null when the run is not
// curvature-measurable: fewer than 3 finite reads (need ≥2 steps to compare an early vs a late
// pace), any non-finite read, or a zero early pace (no defensible base for the ratio — cannot
// happen inside a real run, where every step is ≥1 cent, but guarded so a hand-built input degrades
// safely rather than dividing by zero). Otherwise returns the leak-safe curvature descriptor.
const curvatureOf = (p, band) => {
  const values = Array.isArray(p.values) ? p.values : null
  if (!values || values.length < 3) return null
  if (!values.every(isNum)) return null

  // step magnitudes across the run, in integer cents (drift-free).
  const mags = []
  for (let k = 1; k < values.length; k++) mags.push(Math.abs(toCents(values[k]) - toCents(values[k - 1])))

  // robust early-vs-late split: each half is the leading / trailing ceil(steps/2) magnitudes. For 2
  // steps that is early=mags[0], late=mags[1]; for an odd count the halves overlap on the middle
  // step, damping a single spike instead of letting it swing the verdict.
  const half = Math.ceil(mags.length / 2)
  const earlyPace = mean(mags.slice(0, half))
  const latePace = mean(mags.slice(mags.length - half))
  if (!(earlyPace > 0)) return null

  const paceRatio = latePace / earlyPace
  const paceChangePct = (paceRatio - 1) * 100
  const shape = paceRatio >= 1 + band ? 'accelerating' : paceRatio <= 1 - band ? 'decelerating' : 'steady'

  return {
    metric: String(p.metric),
    label: p.metric_label != null ? String(p.metric_label) : String(p.metric),
    direction: isDir(p.direction) ? p.direction : null,
    improving: p.improving === true ? true : p.improving === false ? false : null,
    shape,
    paceRatio,
    paceChangePct,
    absPaceChangePct: Math.abs(paceChangePct),
    earlyPaceCents: earlyPace,
    latePaceCents: latePace,
    steps: mags.length,
  }
}

// The honest one-line story for the cue. It names the lead mover, what its pace is doing, and — the
// part that protects accuracy — what that implies for the straight-line projection (a floor when
// accelerating, a ceiling when flattening), framed by polarity. Qualitative by design: a
// second-derivative percentage would confuse a consumer, whereas "each update is larger than the
// last" is unambiguous. The agency renders it as-is; the client surface softens only the peripheral
// pill label (in the UI), never this line.
function composeNote(m) {
  const subject = cap(m.label)
  if (m.shape === 'steady') {
    return `${subject}'s pace is holding steady — the linear projection is well-founded.`
  }
  if (m.shape === 'accelerating') {
    if (m.improving === false) {
      return `${subject}'s adverse move is accelerating — each update is larger than the last, so the projection may understate it.`
    }
    if (m.improving === true) {
      return `${subject}'s gain is accelerating — each update is larger than the last; the momentum is compounding.`
    }
    return `${subject}'s move is accelerating — each update is larger than the last.`
  }
  // decelerating
  if (m.improving === true) {
    return `${subject}'s gain is flattening — each update is smaller than the last, so the projection may overstate it.`
  }
  if (m.improving === false) {
    return `${subject}'s adverse move is easing — each update is smaller than the last; it is leveling off.`
  }
  return `${subject}'s move is decelerating — each update is smaller than the last.`
}

// assessNowcastMomentum(nowcast, opts)
//   nowcast : a projectScopeTrend() result ({status:'projected', projections:[...]}).
//   opts    : { steadyBandPct=20 } — the ± half-band (percent of early pace) inside which a pace
//             change reads as "steady".
// Returns { status, reason, shape, band, assessedCount, acceleratingCount, deceleratingCount,
//           steadyCount, biggestMove, decisive, note, meta }.
//   status : 'none'     — no projection carries a curvature-measurable run (≥3 finite reads);
//            'assessed' — ≥1 projection was measured.
//   shape  : the decisive projection's shape — 'accelerating' | 'decelerating' | 'steady'
//            (status 'assessed'), else 'indeterminate'.
//   decisive / biggestMove : the move whose pace bent the most (largest |pace change|); they are the
//            same move — the sharpest bend both sets the overall shape and is the headline mover.
function assessNowcastMomentum(nowcast, opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const steadyBandPct =
    isNum(o.steadyBandPct) && Number(o.steadyBandPct) > 0 ? Number(o.steadyBandPct) : DEFAULT_STEADY_BAND_PCT
  const band = steadyBandPct / 100

  const none = (reason) => ({
    status: 'none',
    reason,
    shape: 'indeterminate',
    band: steadyBandPct,
    assessedCount: 0,
    acceleratingCount: 0,
    deceleratingCount: 0,
    steadyCount: 0,
    biggestMove: null,
    decisive: null,
    note: null,
    meta: { basis: 'run-curvature' },
  })
  try {
    if (!nowcast || typeof nowcast !== 'object' || nowcast.status !== 'projected') return none('no-nowcast')
    const projections = Array.isArray(nowcast.projections) ? nowcast.projections : []

    // Measure every curvature-bearing projection, preserving salience order and deduping by metric
    // id so a malformed double-entry can't double-count. Projections whose run is too short / has a
    // non-finite read / has a zero early pace carry no curvature and are excluded.
    const moves = []
    const seen = new Set()
    for (const p of projections) {
      if (!p || typeof p !== 'object' || p.metric == null) continue
      const id = String(p.metric)
      if (seen.has(id)) continue
      const c = curvatureOf(p, band)
      if (!c) continue
      seen.add(id)
      moves.push(c)
    }

    const assessedCount = moves.length
    if (assessedCount === 0) return none('no-curvature')

    // the sharpest bend leads: largest |pace change|; strict > keeps the FIRST (more salient) on a
    // tie. This is where a straight-line projection is most at risk of being wrong, so it both sets
    // the overall shape and is the headline mover — regardless of polarity (the note frames the
    // accuracy implication honestly by polarity).
    let decisive = null
    for (const m of moves) if (!decisive || m.absPaceChangePct > decisive.absPaceChangePct) decisive = m

    const acceleratingCount = moves.reduce((n, m) => n + (m.shape === 'accelerating' ? 1 : 0), 0)
    const deceleratingCount = moves.reduce((n, m) => n + (m.shape === 'decelerating' ? 1 : 0), 0)
    const steadyCount = moves.reduce((n, m) => n + (m.shape === 'steady' ? 1 : 0), 0)

    return {
      status: 'assessed',
      reason: null,
      shape: decisive.shape,
      band: steadyBandPct,
      assessedCount,
      acceleratingCount,
      deceleratingCount,
      steadyCount,
      biggestMove: decisive,
      decisive,
      note: composeNote(decisive),
      meta: { basis: 'run-curvature' },
    }
  } catch {
    return none('error')
  }
}

module.exports = { assessNowcastMomentum }
