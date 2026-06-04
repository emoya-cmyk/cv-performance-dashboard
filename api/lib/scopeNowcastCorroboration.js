'use strict'
// lib/scopeNowcastCorroboration.js — intel-v14 D7 (step a): does an INDEPENDENT lens AGREE with the
// nowcast, or has the metric just turned against it?
//
// D3 projects where a streak is heading; D4–D6 calibrate how firmly that FORWARD projection may
// speak by backtesting its OWN past error. But a self-backtest is structurally blind to a REGIME
// CHANGE: it measures how well the projection HAS landed and assumes the near future rhymes with the
// recent past, so right at a turning point it can speak most confidently exactly when it is most
// wrong. The honest guard a backtest cannot provide is an INDEPENDENT second opinion — a different
// lens, with its own reference frame, pointed at the same lead metric.
//
// The same scope is already viewed through three temporal lenses on one request:
//   • trend    (D2) — the multi-read run the projection EXTENDS, and
//   • nowcast  (D3) — the forward extrapolation of that run, and
//   • delta    (D1) — how the metric moved SINCE THE CALLER LAST LOOKED (its own `since` snapshot).
// Two of these are NOT independent: scopeNowcast copies the projection's `direction` straight from
// the trend's `direction` (scopeNowcast.js: `const direction = t.direction …`), and the trend's run
// is by construction the maximal SAME-direction streak ending at the latest read — so the trend, the
// latest in-buffer step, and the nowcast all share one "trajectory" direction. Counting the trend as
// a corroborating witness would be tautological: it can never disagree with a projection derived
// from it, so it would only ever pad a confidence it did not independently earn.
//
// The DELTA lens is the genuinely independent cross-check. Its reference frame is the caller's own
// `since` snapshot — which may be the prior read OR an older session baseline — not the buffered run
// the projection extends. So the delta move CAN diverge from the trajectory: a metric can be up
// across its recent run (trend up → nowcast up) yet have ticked DOWN versus where the caller last
// looked — the precise fingerprint of a streak beginning to break. This module reads the lead
// metric's direction from the delta lens and compares it to the projection's trajectory:
//   • aligned — the independent move points the SAME way → the projection is corroborated, lean in.
//   • mixed   — the independent move points the OTHER way → the metric may be turning against its
//               run; however reliable the projection's record, read it with caution.
// When no independent lens is present (the caller sent no `since`), there is nothing honest to
// corroborate against and the module returns { status:'none' } — it never manufactures agreement
// from the trend it would be checking.
//
// This NEVER inflates confidence: it can only add an "aligned" reassurance or a "mixed" caution
// beside the voice; it does not touch nowcast.headline, nowcast.voice, or any number.
//
// Design properties (the same discipline as its D1–D6 siblings):
//   • PURE + leak-safe — inputs are the ALREADY leak-safe projection and delta (metric ids +
//     the run's own directions only). This module sees no clientId and emits none; its output is a
//     metric label + direction words + small counts, identical on the agency and client surfaces.
//   • One direction primitive — agreement is on the SAME raw 'up'/'down' every lens computes via the
//     shared polarity oracle, so the lenses can never be compared inconsistently.
//   • Additive + only ever a tempering — emits a sibling cue; never mutates the voice or the number.
//   • Deterministic + fail-safe — no clock, no RNG, no DB; any malformed input degrades to
//     { status:'none' } and never throws.
const { METRICS } = require('./ask')

const isDir = (d) => d === 'up' || d === 'down'
// A lens entry's direction, only if it is a clean 'up'/'down'. Anything else (flat/null/missing)
// counts as "this lens has no directional read for the metric" — never as a silent disagreement.
const dirOf = (entry) => (entry && isDir(entry.direction) ? entry.direction : null)
// First entry whose metric id matches, compared as strings so a numeric/string id can never miss.
const findByMetric = (arr, metric) =>
  (Array.isArray(arr) ? arr.find((x) => x && x.metric != null && String(x.metric) === metric) : null) || null

// The metric's display label — the projection's own label first (so the cue reads continuous with
// the headline), then the shared descriptor, then the bare id. Never a tenant string.
function labelOf(lead, metric) {
  if (lead && lead.metric_label != null) return String(lead.metric_label)
  return (METRICS[metric] && METRICS[metric].label) || metric
}

// A neutral, leak-safe sentence for the cue. The agency renders it as-is; the client surface softens
// only the peripheral pill label (in the UI), never this honest line. Metric-light by design — the
// voice headline beside it already names the figure — but it names the metric so it reads standalone.
function composeNote(level, label, trajectory, recent) {
  const lower = String(label || '').toLowerCase()
  if (level === 'aligned') {
    return `The latest move in ${lower} also points ${trajectory} — the projection is corroborated.`
  }
  // mixed
  return `The latest move in ${lower} points ${recent}, against the projected ${trajectory} — read it with caution.`
}

// corroborateNowcast(nowcast, delta, opts)
//   nowcast : a projectScopeTrend() result ({status:'projected', projections:[...]}).
//   delta   : a diffScopeInsights() result ({status, changes:[{metric, direction, …}]}) — or null.
//   opts    : reserved for a future per-metric policy (independent-lens requirements); unused today.
// Returns { status, reason, level, leadMetric, leadLabel, trajectory, recent, agree,
//           witnesses, witnessCount, confirmCount, conflictCount, note, meta }.
//   status : 'none'         — no projection / malformed lead / no independent lens for the lead;
//            'corroborated' — the lead trajectory was cross-checked against ≥1 independent lens.
//   level  : 'aligned' (every present independent lens agrees) | 'mixed' (≥1 disagrees) |
//            'unconfirmed' (status 'none' — nothing independent to check).
//   trajectory : the projection's direction ('up'|'down') — what the nowcast claims.
//   recent     : the independent delta direction for the lead ('up'|'down'|null).
//   witnesses  : the present independent lenses, each { lens, direction, agrees }.
function corroborateNowcast(nowcast, delta, opts) {
  const none = (reason) => ({
    status: 'none',
    reason,
    level: 'unconfirmed',
    leadMetric: null,
    leadLabel: null,
    trajectory: null,
    recent: null,
    agree: false,
    witnesses: [],
    witnessCount: 0,
    confirmCount: 0,
    conflictCount: 0,
    note: null,
    meta: { independentLenses: ['delta'], basis: 'cross-lens' },
  })
  try {
    // opts is accepted for signature symmetry with its D4–D6 siblings; no field is read yet.
    void (opts && typeof opts === 'object' ? opts : {})

    // Gate 1: a real projection. The trajectory we corroborate is the LEAD projection (projections[0]).
    if (!nowcast || typeof nowcast !== 'object' || nowcast.status !== 'projected') return none('no-nowcast')
    const projections = Array.isArray(nowcast.projections) ? nowcast.projections : []
    const lead = projections[0]
    if (!lead || lead.metric == null || !isDir(lead.direction)) return none('no-lead')
    const metric = String(lead.metric)
    const trajectory = lead.direction
    const label = labelOf(lead, metric)

    // The independent witnesses. Today there is exactly one honest cross-check — the delta lens —
    // because the trend (and so the latest in-buffer step) is the projection's own basis and can
    // never disagree with it. Kept as a list so a future genuinely-independent lens slots in without
    // reworking the agreement arithmetic.
    const witnesses = []
    const dEntry = delta && typeof delta === 'object' ? findByMetric(delta.changes, metric) : null
    const dDir = dirOf(dEntry)
    if (dDir) witnesses.push({ lens: 'delta', direction: dDir, agrees: dDir === trajectory })

    if (witnesses.length === 0) return none('no-independent-lens')

    const confirmCount = witnesses.filter((w) => w.agrees).length
    const conflictCount = witnesses.length - confirmCount
    const level = conflictCount === 0 ? 'aligned' : 'mixed'
    const recent = dDir // the independent move that drove the verdict (today: delta)

    return {
      status: 'corroborated',
      reason: null,
      level,
      leadMetric: metric,
      leadLabel: label,
      trajectory,
      recent,
      agree: level === 'aligned',
      witnesses,
      witnessCount: witnesses.length,
      confirmCount,
      conflictCount,
      note: composeNote(level, label, trajectory, recent),
      meta: { independentLenses: ['delta'], basis: 'cross-lens' },
    }
  } catch {
    return none('error')
  }
}

module.exports = { corroborateNowcast }
