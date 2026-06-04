'use strict'
// lib/scopeNowcastMateriality.js — intel-v14 D9 (step a): is the projected move BIG ENOUGH to act on?
//
// D8 (scopeNowcastCoherence) reads the whole projection VECTOR and classifies it by POLARITY:
// unified / divergent / deteriorating. That catches the vanity-metric trap — revenue projected up
// while cost per lead is projected up too. But polarity alone is half the story. A basket can be
// "divergent" on paper while the worsening side is a rounding error: revenue projected up ~30% and
// cost per lead projected up ~1%. Calling that a divergence and sounding the same caution as a
// revenue-up-8% / cpl-up-25% basket would be crying wolf — the opposite of accurate.
//
// D9 supplies the missing half: MAGNITUDE. It reads each polarity-bearing projection's |pct| (the
// percent move from the run's current value to its projected value — the one cross-metric-comparable
// size the nowcast already computes) and asks whether the side that MATTERS clears a materiality
// threshold:
//   • material — the decisive move (the worsening side if any, else the gaining side) is ≥ the
//                threshold; whatever D8 said, it is real in size and worth acting on (a material
//                gain, a material slide, or — paired with a divergent D8 verdict — a material
//                divergence).
//   • marginal — the decisive move is under the threshold; the basket is barely moving on the side
//                that counts, so a D8 "divergent" / "deteriorating" verdict should be read as a
//                hairline, not an alarm.
// Together D8 + D9 guard the two opposite failures: D8 stops a vanity metric from hiding trouble;
// D9 stops a trivial wobble from masquerading as trouble. The "decisive side" is the WORSENING side
// when one exists — bad news is what a consumer acts on, so a big headline over a hairline slip reads
// as "marginal divergence", never "material".
//
// Unlike coherence (which needs ≥2 metrics to have anything to cohere WITH), materiality is
// meaningful for a SINGLE projection — "revenue projected up ~30%" is a material move on its own —
// so it speaks on ≥1 polarity-bearing projection, covering the single-metric case D8 stays silent on.
//
// This NEVER inflates confidence: like its D4–D8 siblings it can only add a "material" amplifier or a
// "marginal" temper beside the voice; it does not touch nowcast.headline, nowcast.voice,
// nowcast.coherence, nowcast.corroboration, or any number.
//
// Design properties (the same discipline as its D1–D8 siblings):
//   • PURE + leak-safe — the sole input is the ALREADY leak-safe projection set (metric ids + labels
//     + the run's own directions/polarity/percent only). This module sees no clientId and emits none;
//     its output is metric labels + direction words + integer percents + small counts, identical on
//     the agency and client surfaces.
//   • One polarity oracle — favorable/adverse is the SAME `improving` flag every lens computes, so
//     "material divergence" can never be defined inconsistently across metrics.
//   • Self-contained magnitude — reads projection.pct when present, else recomputes it inline with the
//     exact scopeDelta.pctChange formula ((projected − current) / |current| × 100), so the module
//     neither hard-depends on upstream having set pct nor can drift from the canonical definition.
//   • Additive + only ever a qualifier — emits a sibling cue; never mutates the voice or the number.
//   • Deterministic + fail-safe — no clock, no RNG, no DB; stable salience order (ties resolve to the
//     more salient projection); any malformed input degrades to { status:'none' } and never throws.

const isNum = (v) => v != null && Number.isFinite(Number(v))
const cap = (s) => {
  const str = String(s == null ? '' : s)
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : str
}
const isDir = (d) => d === 'up' || d === 'down'
const pctStr = (absPct) => `~${Math.round(Number(absPct))}%`

// The default materiality cutoff, in PERCENT. A projected move of ≥5% in the very next read is
// notable; under 5% sits in the noise of a hedged one-step extrapolation. Overridable via
// opts.materialPct for a future per-metric or per-tenant policy.
const DEFAULT_MATERIAL_PCT = 5

// The percent move for a projection: prefer the canonical pct the nowcast attached; fall back to the
// exact scopeDelta.pctChange formula when it is absent but current/projected are both finite. Returns
// null when there is no defensible base to divide by (current 0 / non-finite) — that projection then
// carries no magnitude and is excluded from the materiality math (it can be neither material nor
// marginal). Signed; callers size on the absolute value.
const pctOf = (p) => {
  if (isNum(p.pct)) return Number(p.pct)
  if (isNum(p.current) && Number(p.current) !== 0 && isNum(p.projected)) {
    return ((Number(p.projected) - Number(p.current)) / Math.abs(Number(p.current))) * 100
  }
  return null
}

// A compact, leak-safe descriptor of one sized projection: the metric id, its label, the raw
// direction (for the UI arrow), its polarity, and both the signed pct and its magnitude. No tenant data.
const moveOf = (p, pct) => ({
  metric: String(p.metric),
  label: p.metric_label != null ? String(p.metric_label) : String(p.metric),
  direction: isDir(p.direction) ? p.direction : null,
  improving: p.improving === true ? true : p.improving === false ? false : null,
  pct,
  absPct: Math.abs(pct),
})

// The honest one-line story for the cue. Metric-light by design but it names the lead mover and its
// size so it reads standalone. The agency renders it as-is; the client surface softens only the
// peripheral pill label (in the UI), never this line.
function composeNote(level, threshold, assessedCount, biggestMove, biggestFavorable, biggestAdverse) {
  if (level === 'material') {
    // level 'material' ⟹ the decisive side (the worsening one if any, else the gaining one)
    // cleared the threshold.
    if (biggestAdverse) {
      // a material worsening; with a favorable also present it is a genuine (material) divergence.
      const tail = biggestFavorable ? 'a material divergence, not noise' : 'a material slide'
      return `${cap(biggestAdverse.label)} is projected to worsen ${pctStr(biggestAdverse.absPct)} — ${tail}.`
    }
    return `${cap(biggestFavorable.label)} is projected up ${pctStr(biggestFavorable.absPct)} — a material gain.`
  }
  // marginal — the side that matters is under the threshold.
  if (biggestFavorable && biggestAdverse && biggestFavorable.absPct >= threshold) {
    // a big headline over a hairline worsening → the DIVERGENCE is marginal even though the headline
    // itself moved materially. Name both so the chip's "marginal" reads honestly, not as a denial
    // that anything is happening.
    return `${cap(biggestFavorable.label)} is projected up ${pctStr(biggestFavorable.absPct)}, while the worsening side stays under ${pctStr(threshold)} — the divergence is marginal.`
  }
  if (assessedCount === 1 && biggestMove) {
    return `${cap(biggestMove.label)} is projected to move under ${pctStr(threshold)} — a marginal shift.`
  }
  return `Every projected move is under ${pctStr(threshold)} — the shifts are marginal, not yet decisive.`
}

// assessNowcastMateriality(nowcast, opts)
//   nowcast : a projectScopeTrend() result ({status:'projected', projections:[...]}).
//   opts    : { materialPct=5 } — the percent cutoff for a "material" projected move.
// Returns { status, reason, level, threshold, assessedCount, materialCount, marginalCount,
//           biggestMove, biggestFavorable, biggestAdverse, decisive, note, meta }.
//   status : 'none'     — no projection / no polarity-bearing projection carries a finite magnitude;
//            'assessed' — ≥1 polarity-bearing projection was sized.
//   level  : 'material' (the decisive move clears the threshold) | 'marginal' (it does not) |
//            'indeterminate' (status 'none').
//   decisive : the move that set the level (the worsening side if any, else the gaining side).
//   materialCount/marginalCount : the RAW tally across all sized moves (can differ from `level`,
//            which keys only on the decisive side — e.g. a material gain over a marginal slip is
//            level 'marginal' yet materialCount 1).
function assessNowcastMateriality(nowcast, opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const threshold = isNum(o.materialPct) && Number(o.materialPct) > 0 ? Number(o.materialPct) : DEFAULT_MATERIAL_PCT

  const none = (reason) => ({
    status: 'none',
    reason,
    level: 'indeterminate',
    threshold,
    assessedCount: 0,
    materialCount: 0,
    marginalCount: 0,
    biggestMove: null,
    biggestFavorable: null,
    biggestAdverse: null,
    decisive: null,
    note: null,
    meta: { basis: 'projection-magnitude' },
  })
  try {
    if (!nowcast || typeof nowcast !== 'object' || nowcast.status !== 'projected') return none('no-nowcast')
    const projections = Array.isArray(nowcast.projections) ? nowcast.projections : []

    // Size every polarity-bearing projection by |pct|, preserving salience order and deduping by
    // metric id so a malformed double-entry can't double-count. Null-polarity projections are
    // excluded (they pair with no D8 verdict); so are polarity-bearing ones with no finite magnitude.
    const moves = []
    const seen = new Set()
    for (const p of projections) {
      if (!p || typeof p !== 'object' || p.metric == null) continue
      if (p.improving !== true && p.improving !== false) continue
      const id = String(p.metric)
      if (seen.has(id)) continue
      const pct = pctOf(p)
      if (!isNum(pct)) continue
      seen.add(id)
      moves.push(moveOf(p, Number(pct)))
    }

    const assessedCount = moves.length
    if (assessedCount === 0) return none('no-magnitude')

    // biggest-by-magnitude selections; strict > keeps the FIRST (more salient) on a tie.
    const maxBy = (arr) => {
      let best = null
      for (const m of arr) if (!best || m.absPct > best.absPct) best = m
      return best
    }
    const biggestFavorable = maxBy(moves.filter((m) => m.improving === true))
    const biggestAdverse = maxBy(moves.filter((m) => m.improving === false))
    const biggestMove = maxBy(moves)

    // The level keys on the side that warrants action: the worsening side when one exists, else the
    // gaining side. So a big gain over a hairline slip is 'marginal' (the divergence isn't real),
    // and a material worsening is 'material' however small the headline gain.
    const decisive = biggestAdverse || biggestFavorable
    const level = decisive.absPct >= threshold ? 'material' : 'marginal'

    const materialCount = moves.reduce((n, m) => n + (m.absPct >= threshold ? 1 : 0), 0)
    const marginalCount = assessedCount - materialCount

    return {
      status: 'assessed',
      reason: null,
      level,
      threshold,
      assessedCount,
      materialCount,
      marginalCount,
      biggestMove,
      biggestFavorable,
      biggestAdverse,
      decisive,
      note: composeNote(level, threshold, assessedCount, biggestMove, biggestFavorable, biggestAdverse),
      meta: { basis: 'projection-magnitude' },
    }
  } catch {
    return none('error')
  }
}

module.exports = { assessNowcastMateriality }
