'use strict'

// Tests for lib/reallocationEfficacy.js — the reallocation feedback loop. Pins the cost-per-
// outcome gap math, the four-way classify (vindicated/refuted/neutral/unmeasurable) and its
// VIND_FRAC boundary, the liberal decision/realized shape extraction, the strength + pair keys,
// the decided-only tally, the Beta-Bernoulli + Wilson math against hand arithmetic, the median/
// mean conventions, the confidence CALIBRATION knob (neutral no-op at low n, damp when over-
// confident, embolden — capped — when under), the ranked-table pipeline, note gating on earned
// sample size, and the no-evidence / junk no-op. Same node:test house style as efficacy.test.js.

const { test } = require('node:test')
const assert   = require('node:assert/strict')

const {
  classifyTrial, tallyTrials, rateOf,
  gapOf, cpoOf, strengthOf, pairOf,
  hitRateOf, wilsonLower, medianOf, meanOf, bandOf, baseRateOf,
  calibrationOf, reallocationEfficacyTable, reallocationEfficacyNote,
  PRIOR_WEIGHT, PRIOR_MEAN, VIND_FRAC, HIT_LOW, HIT_HIGH, NOTE_MIN_N, CAL_MIN, CAL_MAX, OVERALL_KEY,
} = require('../lib/reallocationEfficacy')

const approx = (a, b, eps = 1e-3) =>
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b} (±${eps})`)

// ── cpoOf / gapOf: the cost-per-outcome gap primitives ────────────────────────
test('cpoOf: finite positive only; 0/neg/junk → null', () => {
  assert.equal(cpoOf(30), 30)
  assert.equal(cpoOf(0), null)        // a cpo of 0 is not a real cost
  assert.equal(cpoOf(-5), null)
  assert.equal(cpoOf('x'), null)
  assert.equal(cpoOf(null), null)
  assert.equal(cpoOf(Infinity), null)
})

test('gapOf: relative (from − to)/from; positive ⇒ "to" is cheaper', () => {
  approx(gapOf(60, 30), 0.5)          // to is 50% cheaper per outcome
  approx(gapOf(100, 70), 0.3)
  approx(gapOf(40, 50), -0.25)        // to is MORE expensive ⇒ negative
  assert.equal(gapOf(0, 30), null)    // no positive anchor
  assert.equal(gapOf(60, 0), null)    // to not a real cost
  assert.equal(gapOf('x', 30), null)
})

// ── classifyTrial: the line between a SAMPLE and a non-sample ──────────────────
test('classifyTrial: edge held ≥ VIND_FRAC of the predicted gap → vindicated', () => {
  // decision gap 0.5; realized gap 0.5 (held in full) → hold_ratio 1.0
  const g = classifyTrial({ decision: { from_cpo: 60, to_cpo: 30 }, realized: { from_cpo: 60, to_cpo: 30 } })
  assert.equal(g.label, 'vindicated')
  approx(g.decision_gap, 0.5); approx(g.realized_gap, 0.5); approx(g.hold_ratio, 1)
})

test('classifyTrial: VIND_FRAC boundary is inclusive (hold_ratio === 0.5 → vindicated)', () => {
  // decision gap 0.5; realized gap 0.25 → hold_ratio exactly 0.5
  const g = classifyTrial({ decision: { from_cpo: 60, to_cpo: 30 }, realized: { from_cpo: 60, to_cpo: 45 } })
  assert.equal(g.label, 'vindicated')
  approx(g.realized_gap, 0.25); approx(g.hold_ratio, 0.5)
})

test('classifyTrial: edge shrank but stayed positive → neutral (PENDING, not a sample)', () => {
  // decision gap 0.5; realized gap 0.1 → hold_ratio 0.2 < VIND_FRAC, still > 0
  const g = classifyTrial({ decision: { from_cpo: 60, to_cpo: 30 }, realized: { from_cpo: 50, to_cpo: 45 } })
  assert.equal(g.label, 'neutral')
  approx(g.realized_gap, 0.1); approx(g.hold_ratio, 0.2)
})

test('classifyTrial: edge reversed or collapsed to parity → refuted', () => {
  // realized "to" is now MORE expensive → realized gap < 0
  assert.equal(classifyTrial({ decision: { from_cpo: 60, to_cpo: 30 }, realized: { from_cpo: 40, to_cpo: 50 } }).label, 'refuted')
  // realized parity → realized gap exactly 0 (≤ 0) → refuted: "to" no longer the better-value channel
  assert.equal(classifyTrial({ decision: { from_cpo: 60, to_cpo: 30 }, realized: { from_cpo: 50, to_cpo: 50 } }).label, 'refuted')
})

test('classifyTrial: decision gap falls back to stated gap_pct when cpo pair absent', () => {
  const g = classifyTrial({ decision: { gap_pct: 0.4 }, realized: { from_cpo: 100, to_cpo: 70 } })
  assert.equal(g.label, 'vindicated')   // realized 0.3 / 0.4 = 0.75 ≥ VIND_FRAC
  approx(g.decision_gap, 0.4); approx(g.hold_ratio, 0.75)
})

test('classifyTrial: non-positive decision edge is never graded → unmeasurable', () => {
  // a "proposal" where to was already pricier (gap ≤ 0) was never a real positive-edge move
  assert.equal(classifyTrial({ decision: { from_cpo: 30, to_cpo: 60 }, realized: { from_cpo: 30, to_cpo: 60 } }).label, 'unmeasurable')
  assert.equal(classifyTrial({ decision: { from_cpo: 0, to_cpo: 30 }, realized: { from_cpo: 60, to_cpo: 30 } }).label, 'unmeasurable')
})

test('classifyTrial: missing/garbage realized → unmeasurable (a quiet skip, never a throw)', () => {
  assert.equal(classifyTrial({ decision: { from_cpo: 60, to_cpo: 30 } }).label, 'unmeasurable')
  assert.equal(classifyTrial({ decision: { from_cpo: 60, to_cpo: 30 }, realized: { from_cpo: 'x', to_cpo: 30 } }).label, 'unmeasurable')
  assert.equal(classifyTrial(null).label, 'unmeasurable')
  assert.equal(classifyTrial({}).label, 'unmeasurable')
})

test('classifyTrial: liberal shape — decision|proposal|top-level × realized|after|outcome', () => {
  assert.equal(classifyTrial({ proposal: { from_cpo: 60, to_cpo: 30 }, after:   { from_cpo: 60, to_cpo: 30 } }).label, 'vindicated')
  assert.equal(classifyTrial({ from_cpo: 60, to_cpo: 30,               outcome: { from_cpo: 60, to_cpo: 30 } }).label, 'vindicated')
  // `decision` wins over a top-level shape when both present
  assert.equal(classifyTrial({ decision: { from_cpo: 60, to_cpo: 30 }, from_cpo: 10, to_cpo: 9, realized: { from_cpo: 60, to_cpo: 30 } }).label, 'vindicated')
})

// ── strength / pair keys ──────────────────────────────────────────────────────
test('strengthOf: normalizes the three real bands; unknown → unrated', () => {
  assert.equal(strengthOf({ decision: { strength: 'STRONG' } }), 'strong')
  assert.equal(strengthOf({ proposal: { strength: 'Tentative' } }), 'tentative')
  assert.equal(strengthOf({ strength: 'moderate' }), 'moderate')
  assert.equal(strengthOf({ decision: { strength: 'wat' } }), 'unrated')
  assert.equal(strengthOf({}), 'unrated')
  assert.equal(strengthOf(null), 'unrated')
})

test('pairOf: from->to, or null when either side missing', () => {
  assert.equal(pairOf({ decision: { from: 'meta', to: 'google_ads' } }), 'meta->google_ads')
  assert.equal(pairOf({ proposal: { from: 'meta' } }), null)
  assert.equal(pairOf({}), null)
})

// ── tallyTrials: decided-only, overall + byStrength + byPair ───────────────────
test('tallyTrials: counts only decided trials; collects hold ratios + confidences', () => {
  const trials = [
    { decision: { from: 'meta', to: 'google_ads', strength: 'strong', confidence: 0.7, from_cpo: 60, to_cpo: 30 }, realized: { from_cpo: 60, to_cpo: 30 } }, // vindicated, hold 1.0
    { decision: { from: 'meta', to: 'google_ads', strength: 'strong', confidence: 0.6, from_cpo: 60, to_cpo: 30 }, realized: { from_cpo: 40, to_cpo: 50 } }, // refuted
    { decision: { from: 'meta', to: 'google_ads', strength: 'tentative', confidence: 0.5, from_cpo: 60, to_cpo: 30 }, realized: { from_cpo: 50, to_cpo: 45 } }, // neutral → pending
    { decision: { from: 'lsa', to: 'google_ads', strength: 'tentative', confidence: 0.4, from_cpo: 80, to_cpo: 40 }, realized: { from_cpo: 80, to_cpo: 44 } }, // vindicated, hold (0.45/0.5)=0.9
    { decision: { from: 'lsa', to: 'google_ads', strength: 'moderate' } }, // unmeasurable → pending
  ]
  const { byStrength, byPair, overall } = tallyTrials(trials)
  assert.equal(overall.n, 3)                 // 2 vindicated + 1 refuted; neutral & unmeasurable excluded
  assert.equal(overall.vindicated, 2)
  assert.equal(overall.refuted, 1)
  assert.equal(overall.confidences.length, 3)
  assert.equal(overall.hold_ratios.length, 3)

  assert.equal(byStrength.get('strong').n, 2)
  assert.equal(byStrength.get('strong').vindicated, 1)
  assert.equal(byStrength.get('strong').refuted, 1)
  assert.equal(byStrength.get('tentative').n, 1)      // the lsa vindicated one; the meta neutral didn't count
  assert.equal(byStrength.get('tentative').vindicated, 1)
  assert.equal(byStrength.has('moderate'), false)     // its only trial was unmeasurable

  assert.equal(byPair.get('meta->google_ads').n, 2)
  assert.equal(byPair.get('lsa->google_ads').n, 1)
})

test('tallyTrials: junk input → empty tally, never throws', () => {
  const { byStrength, byPair, overall } = tallyTrials('nope')
  assert.equal(overall.n, 0)
  assert.equal(byStrength.size, 0)
  assert.equal(byPair.size, 0)
})

// ── rateOf / hitRateOf / wilsonLower: math against hand arithmetic ─────────────
test('rateOf: raw vindication rate, null with no decided', () => {
  approx(rateOf({ vindicated: 3, refuted: 1 }), 0.75)
  assert.equal(rateOf({ vindicated: 0, refuted: 0 }), null)
  assert.equal(rateOf({}), null)
})

test('hitRateOf: Beta-Bernoulli shrinkage = (v + pm·K)/(n + K)', () => {
  // 9/10 with neutral prior (0.5, K=6): (9 + 3)/(10 + 6) = 0.75
  approx(hitRateOf({ vindicated: 9, refuted: 1 }), 0.75)
  // 3/4: (3 + 3)/(4 + 6) = 0.6
  approx(hitRateOf({ vindicated: 3, refuted: 1 }), 0.6)
  // n = 0 → exactly the prior mean
  approx(hitRateOf({ vindicated: 0, refuted: 0 }), PRIOR_MEAN)
  // explicit prior shifts the shrink target: (9 + 0.8·6)/16 = 13.8/16 = 0.8625
  approx(hitRateOf({ vindicated: 9, refuted: 1 }, { priorMean: 0.8 }), 0.8625)
})

test('wilsonLower: 95% lower bound; rewards depth (9/10 ≫ 1/1); n=0 → 0', () => {
  approx(wilsonLower({ vindicated: 9, refuted: 1 }), 0.596)
  approx(wilsonLower({ vindicated: 1, refuted: 0 }), 0.207)
  assert.ok(wilsonLower({ vindicated: 9, refuted: 1 }) > wilsonLower({ vindicated: 1, refuted: 0 }))
  assert.equal(wilsonLower({ vindicated: 0, refuted: 0 }), 0)
})

// ── medianOf / meanOf / bandOf / baseRateOf ───────────────────────────────────
test('medianOf: ascending; even-length averages the two middles; empty → null', () => {
  assert.equal(medianOf([0.9, 0.1, 0.5]), 0.5)
  assert.equal(medianOf([0.2, 0.4, 0.6, 0.8]), 0.5)   // (0.4 + 0.6)/2
  assert.equal(medianOf([]), null)
  assert.equal(medianOf('x'), null)
})

test('meanOf: arithmetic mean; empty/junk → null', () => {
  approx(meanOf([0.4, 0.6, 0.8]), 0.6)
  assert.equal(meanOf([]), null)
  assert.equal(meanOf(['x']), null)
})

test('bandOf: HIT_LOW / HIT_HIGH thresholds', () => {
  assert.equal(bandOf(HIT_LOW - 0.01), 'low')
  assert.equal(bandOf(0.5), 'medium')
  assert.equal(bandOf(HIT_HIGH), 'high')
  assert.equal(bandOf('x'), 'medium')   // junk → neutral band
})

test('baseRateOf: pools all decided trials; null mean until ≥1 decided', () => {
  const trials = [
    { decision: { from_cpo: 60, to_cpo: 30 }, realized: { from_cpo: 60, to_cpo: 30 } }, // vindicated
    { decision: { from_cpo: 60, to_cpo: 30 }, realized: { from_cpo: 60, to_cpo: 30 } }, // vindicated
    { decision: { from_cpo: 60, to_cpo: 30 }, realized: { from_cpo: 60, to_cpo: 30 } }, // vindicated
    { decision: { from_cpo: 60, to_cpo: 30 }, realized: { from_cpo: 40, to_cpo: 50 } }, // refuted
    { decision: { from_cpo: 60, to_cpo: 30 }, realized: { from_cpo: 50, to_cpo: 45 } }, // neutral (pending)
  ]
  const base = baseRateOf(trials)
  approx(base.mean, 0.75); assert.equal(base.n, 4)
  const none = baseRateOf([{ decision: { from_cpo: 60, to_cpo: 30 } }]) // unmeasurable only
  assert.equal(none.mean, null); assert.equal(none.n, 0)
})

// ── calibrationOf: the confidence knob the engine consumes ─────────────────────
test('calibrationOf: no evidence → neutral 1.0 (a behavioral no-op)', () => {
  const c = calibrationOf({ vindicated: 0, refuted: 0, confidences: [] })
  assert.equal(c.factor, 1)
  assert.equal(c.n, 0)
})

test('calibrationOf: over-confident bets DAMP future confidence (factor < 1)', () => {
  // 3/10 held, but we had assigned 0.8 confidence → over-confident
  const conf = Array.from({ length: 10 }, () => 0.8)
  const c = calibrationOf({ vindicated: 3, refuted: 7, confidences: conf })
  // hit = (3+3)/16 = 0.375; raw = 0.375/0.8 = 0.469 → clamp 0.5; cred = 10/16 = 0.625
  // shrunk = 1 + (0.5−1)·0.625 = 0.6875 → 0.688
  approx(c.factor, 0.688)
  assert.ok(c.factor < 1)
  approx(c.hit_rate, 0.375); approx(c.mean_confidence, 0.8)
  assert.match(c.basis, /damp/i)
})

test('calibrationOf: under-confident bets EMBOLDEN — but capped at CAL_MAX', () => {
  // 9/10 held while we only assigned 0.5 → under-confident
  const conf = Array.from({ length: 10 }, () => 0.5)
  const c = calibrationOf({ vindicated: 9, refuted: 1, confidences: conf })
  // hit = (9+3)/16 = 0.75; raw = 1.5 → clamp 1.2; cred 0.625; shrunk = 1 + 0.2·0.625 = 1.125
  approx(c.factor, 1.125)
  assert.ok(c.factor > 1 && c.factor <= CAL_MAX)
  assert.match(c.basis, /embold/i)
})

test('calibrationOf: factor shrinks toward 1.0 with thin evidence (credibility)', () => {
  // same over-confidence signal but only n=2 → credibility 2/8 = 0.25 → barely moves
  const c = calibrationOf({ vindicated: 0, refuted: 2, confidences: [0.8, 0.8] })
  // hit = (0+3)/8 = 0.375; raw 0.469 → clamp 0.5; shrunk = 1 + (0.5−1)·0.25 = 0.875
  approx(c.factor, 0.875)
  assert.ok(c.factor > 0.6)   // thin evidence → near-neutral, not slammed to the floor
})

test('calibrationOf: no assigned-confidence history → neutral, flagged', () => {
  const c = calibrationOf({ vindicated: 5, refuted: 5, confidences: [] })
  assert.equal(c.factor, 1)
  assert.match(c.basis, /insufficient/i)
})

test('calibrationOf: factor never escapes [CAL_MIN, CAL_MAX]; junk → neutral', () => {
  const hi = calibrationOf({ vindicated: 50, refuted: 0, confidences: Array.from({ length: 50 }, () => 0.1) })
  assert.ok(hi.factor <= CAL_MAX && hi.factor >= CAL_MIN)
  const c0 = calibrationOf(null)
  assert.equal(c0.factor, 1)
})

// ── reallocationEfficacyTable: the one-call pipeline ───────────────────────────
function sampleTrials() {
  return [
    { decision: { from: 'meta', to: 'google_ads', strength: 'strong', confidence: 0.7, from_cpo: 60, to_cpo: 30 }, realized: { from_cpo: 60, to_cpo: 30 } }, // vindicated
    { decision: { from: 'meta', to: 'google_ads', strength: 'strong', confidence: 0.7, from_cpo: 60, to_cpo: 30 }, realized: { from_cpo: 62, to_cpo: 33 } }, // vindicated (0.468/0.5=0.94)
    { decision: { from: 'meta', to: 'google_ads', strength: 'strong', confidence: 0.65, from_cpo: 60, to_cpo: 30 }, realized: { from_cpo: 40, to_cpo: 50 } }, // refuted
    { decision: { from: 'lsa', to: 'google_ads', strength: 'tentative', confidence: 0.45, from_cpo: 80, to_cpo: 40 }, realized: { from_cpo: 80, to_cpo: 44 } }, // vindicated
    { decision: { from: 'lsa', to: 'google_ads', strength: 'tentative', confidence: 0.4, from_cpo: 80, to_cpo: 40 }, realized: { from_cpo: 70, to_cpo: 66 } }, // neutral (pending)
  ]
}

test('reallocationEfficacyTable: shape, overall, base, calibration, byPair', () => {
  const t = reallocationEfficacyTable(sampleTrials())
  // overall: 3 vindicated + 1 refuted = 4 decided
  assert.equal(t.overall.key, OVERALL_KEY)
  assert.equal(t.overall.n, 4)
  assert.equal(t.overall.vindicated, 3)
  assert.equal(t.overall.refuted, 1)
  approx(t.base.rate, 0.75); assert.equal(t.base.n, 4)
  // prior shrank toward the pooled base rate (0.75), not the neutral 0.5
  approx(t.base.prior, 0.75)
  // strength bands
  assert.equal(t.byStrength.get('strong').n, 3)
  assert.equal(t.byStrength.get('strong').vindicated, 2)
  assert.equal(t.byStrength.get('tentative').n, 1)
  assert.ok(Number.isFinite(t.byStrength.get('strong').rank))
  // pairs
  assert.equal(t.byPair.get('meta->google_ads').n, 3)
  assert.equal(t.byPair.get('lsa->google_ads').n, 1)
  // calibration present and in-band
  assert.ok(t.calibration.factor >= CAL_MIN && t.calibration.factor <= CAL_MAX)
  assert.equal(t.calibration.n, 4)
})

test('reallocationEfficacyTable: ranked is deepest-evidence-first and deterministic', () => {
  const t = reallocationEfficacyTable(sampleTrials())
  for (let i = 1; i < t.ranked.length; i++) {
    assert.ok(t.ranked[i - 1].lower >= t.ranked[i].lower, 'ranked by Wilson lower bound desc')
    assert.equal(t.ranked[i].rank, i + 1)
  }
  // purity: same trials → identical served structure
  const a = reallocationEfficacyTable(sampleTrials())
  const b = reallocationEfficacyTable(sampleTrials())
  assert.deepEqual([...a.byStrength.entries()], [...b.byStrength.entries()])
  assert.deepEqual(a.overall, b.overall)
  assert.deepEqual(a.calibration, b.calibration)
})

test('reallocationEfficacyTable: junk / empty → empty table, neutral calibration, never throws', () => {
  for (const bad of [null, undefined, 'x', [], [{}], [null]]) {
    const t = reallocationEfficacyTable(bad)
    assert.equal(t.overall.n, 0)
    assert.equal(t.byStrength.size, 0)
    assert.equal(t.calibration.factor, 1)
    assert.equal(t.base.n, 0)
  }
})

// ── reallocationEfficacyNote: a band's own track record (AGENCY only) ──────────
test('reallocationEfficacyNote: grounded sentence above NOTE_MIN_N; silent below', () => {
  const map = new Map([
    ['strong', { key: 'strong', n: 10, vindicated: 9, refuted: 1, hit_rate: 0.75, median_hold: 0.95, band: 'high' }],
    ['tentative', { key: 'tentative', n: 2, vindicated: 1, refuted: 1, hit_rate: 0.5, median_hold: 0.5, band: 'medium' }],
  ])
  const note = reallocationEfficacyNote('strong', { byStrength: map })
  assert.ok(note && /75% of the time \(9 of 10\)/.test(note.text))
  assert.ok(/held in full/.test(note.text))   // median_hold ≥ 0.9
  assert.equal(note.pct, 75); assert.equal(note.vindicated, 9); assert.equal(note.n, 10)
  // below the earned-sample floor → null (never boast off a hunch)
  assert.equal(reallocationEfficacyNote('tentative', { byStrength: map }), null)
  // a band not in the table → null
  assert.equal(reallocationEfficacyNote('moderate', { byStrength: map }), null)
})

test('reallocationEfficacyNote: median_hold tunes the tail clause', () => {
  const mk = (hold) => new Map([['strong', { key: 'strong', n: 6, vindicated: 4, refuted: 2, hit_rate: 0.66, median_hold: hold, band: 'high' }]])
  assert.match(reallocationEfficacyNote('strong', { byStrength: mk(0.95) }).text, /held in full/)
  assert.match(reallocationEfficacyNote('strong', { byStrength: mk(0.7) }).text, /most of the cost edge holding/)
  assert.match(reallocationEfficacyNote('strong', { byStrength: mk(0.3) }).text, /edge typically narrowed/)
})

test('reallocationEfficacyNote: accepts a trial (reads its strength) or a bare band string', () => {
  const map = new Map([['strong', { key: 'strong', n: 8, vindicated: 6, refuted: 2, hit_rate: 0.7, median_hold: 0.8, band: 'high' }]])
  const viaTrial = reallocationEfficacyNote({ decision: { strength: 'STRONG' } }, { byStrength: map })
  const viaString = reallocationEfficacyNote('strong', { byStrength: map })
  assert.deepEqual(viaTrial, viaString)
})

test('reallocationEfficacyNote: accepts a bare Map (not just the table envelope); junk → null', () => {
  const map = new Map([['strong', { key: 'strong', n: 5, vindicated: 4, refuted: 1, hit_rate: 0.72, median_hold: 0.9, band: 'high' }]])
  assert.ok(reallocationEfficacyNote('strong', map))     // bare Map accepted
  assert.equal(reallocationEfficacyNote('strong', null), null)
  assert.equal(reallocationEfficacyNote('strong', {}), null)
})

// ── end-to-end: table → note reads off the very record the pipeline built ──────
test('reallocationEfficacyTable → reallocationEfficacyNote: integrated, grounded', () => {
  // eight strong trials, six vindicated → enough to clear NOTE_MIN_N
  const trials = []
  for (let i = 0; i < 6; i++) trials.push({ decision: { from: 'meta', to: 'google_ads', strength: 'strong', confidence: 0.7, from_cpo: 60, to_cpo: 30 }, realized: { from_cpo: 60, to_cpo: 30 } })
  for (let i = 0; i < 2; i++) trials.push({ decision: { from: 'meta', to: 'google_ads', strength: 'strong', confidence: 0.7, from_cpo: 60, to_cpo: 30 }, realized: { from_cpo: 40, to_cpo: 50 } })
  const t = reallocationEfficacyTable(trials)
  assert.equal(t.byStrength.get('strong').n, 8)
  assert.equal(t.byStrength.get('strong').vindicated, 6)
  const note = reallocationEfficacyNote('strong', t)
  assert.ok(note && /\(6 of 8\)/.test(note.text))
  assert.ok(note.pct >= 60 && note.pct <= 80)
})

// ── exported constants are sane ────────────────────────────────────────────────
test('constants: documented values', () => {
  assert.equal(PRIOR_WEIGHT, 6)
  assert.equal(PRIOR_MEAN, 0.5)
  assert.equal(VIND_FRAC, 0.5)
  assert.ok(HIT_LOW < HIT_HIGH)
  assert.equal(NOTE_MIN_N, 4)
  assert.ok(CAL_MIN < 1 && CAL_MAX > 1)
  assert.equal(OVERALL_KEY, '__overall__')
})
