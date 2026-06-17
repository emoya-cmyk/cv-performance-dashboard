// ============================================================
// test/precision.test.js — the self-IMPROVING precision loop.
//
// lib/precision.js learns which KINDS of finding a given client actually acts on.
// Every insight's lifecycle is a free label: resolved/acknowledged → the human
// engaged; expired → it auto-closed unacted (ignored); open → no verdict yet. The
// module shrinks each per-signature engaged-rate toward a prior (Beta-Bernoulli) so
// one lucky sample can't swing a ranking, turns that confidence into a band + a feed
// weight, and — critically — is a perfect NO-OP until there's history: zero samples →
// confidence 0.5 → weight exactly 1.0 → today's ranking, byte for byte. These tests
// pin: the outcome mapping, the signature key, the tally, the shrinkage math + its
// null/junk guards, the band thresholds, the centered weight envelope, and the
// one-call confidenceTable pipeline. Pure functions: no DB, no clock.
// ============================================================

'use strict'

const { test } = require('node:test')
const assert   = require('node:assert/strict')

const {
  classifyOutcome, signatureKey, tallyOutcomes, rateOf,
  confidenceOf, bandOf, weightFor, baseRateOf, confidenceTable,
  PRIOR_WEIGHT, PRIOR_MEAN, BAND_LOW, BAND_HIGH, WEIGHT_MIN, WEIGHT_MAX,
} = require('..')

const approx = (a, b, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b}`)

// ---- classifyOutcome -------------------------------------------------------

test('classifyOutcome: a human acted (resolved/acknowledged) → engaged', () => {
  assert.equal(classifyOutcome('resolved'), 'engaged')
  assert.equal(classifyOutcome('acknowledged'), 'engaged')   // attention IS the signal
})

test('classifyOutcome: auto-closed (expired) → ignored; still-live → pending', () => {
  assert.equal(classifyOutcome('expired'), 'ignored')
  assert.equal(classifyOutcome('open'), 'pending')           // no verdict → not a sample
  assert.equal(classifyOutcome('something_new'), 'pending')  // unknown stays pending
  assert.equal(classifyOutcome(undefined), 'pending')
  assert.equal(classifyOutcome(null), 'pending')
})

test('classifyOutcome: an engine-proven recovery (recovered) → engaged, NOT ignored', () => {
  // intel-v4 (3b)'s central fix. A finding so accurate the underlying problem actually
  // got FIXED (metric back to baseline, channel reconnected — see lib/outcomes.js) is
  // the strongest true positive there is. The old rule read EVERY expiry as ignored and
  // so scored these wins backwards, sinking the kinds that work. 'recovered' must land in
  // the SAME engaged bucket as a human acknowledgement.
  assert.equal(classifyOutcome('recovered'), 'engaged')
})

test('precision math: a recovery lifts a kind while an unacted expiry sinks it', () => {
  // Two signatures, identical but for the terminal outcome of their one decided sample.
  // Before 3b BOTH counted as 'ignored' and scored identically low; now the proven
  // recovery is engaged. With each signature's lone sample shrunk toward the pooled base
  // rate (1 engaged / 2 decided = 0.5), the win lands above that neutral point and the
  // expiry below it — so the recovery both out-confidences AND out-weights the lapse.
  const table = confidenceTable([
    { kind: 'anomaly', metric: 'leads',   status: 'recovered' },
    { kind: 'anomaly', metric: 'revenue', status: 'expired'   },
  ])
  const win  = table.get('anomaly::leads')
  const lose = table.get('anomaly::revenue')
  assert.equal(win.engaged, 1);  assert.equal(win.ignored, 0)
  assert.equal(lose.engaged, 0); assert.equal(lose.ignored, 1)
  assert.ok(win.confidence > lose.confidence, 'a proven recovery must outrank an unacted expiry')
  assert.ok(win.weight > lose.weight, 'and carry a higher feed weight')
})

// ---- signatureKey ----------------------------------------------------------

test('signatureKey: kind::metric is the unit a client taste is learned at', () => {
  assert.equal(signatureKey({ kind: 'forecast', metric: 'revenue' }), 'forecast::revenue')
  assert.equal(signatureKey({ kind: 'pacing', metric: 'spend' }), 'pacing::spend')
})

test('signatureKey: a metric-less finding keys on kind::*; junk → unknown::*', () => {
  assert.equal(signatureKey({ kind: 'data_health' }), 'data_health::*')
  assert.equal(signatureKey({ kind: 'data_health', metric: null }), 'data_health::*')
  assert.equal(signatureKey({}), 'unknown::*')
  assert.equal(signatureKey(null), 'unknown::*')
})

// ---- tallyOutcomes ---------------------------------------------------------

test('tallyOutcomes: rolls rows into per-signature engaged/ignored counts, pending excluded', () => {
  const t = tallyOutcomes([
    { kind: 'forecast', metric: 'revenue', status: 'resolved' },     // engaged
    { kind: 'forecast', metric: 'revenue', status: 'acknowledged' }, // engaged
    { kind: 'forecast', metric: 'revenue', status: 'expired' },      // ignored
    { kind: 'forecast', metric: 'revenue', status: 'open' },         // pending → dropped
    { kind: 'pacing',   metric: 'spend',   status: 'expired' },      // ignored
  ])
  assert.deepEqual(t.get('forecast::revenue'),
    { kind: 'forecast', metric: 'revenue', engaged: 2, ignored: 1, n: 3 })
  assert.deepEqual(t.get('pacing::spend'),
    { kind: 'pacing', metric: 'spend', engaged: 0, ignored: 1, n: 1 })
  assert.equal(t.size, 2)   // the lone open row created no signature
})

test('tallyOutcomes: degenerate input → empty map, never throws', () => {
  assert.equal(tallyOutcomes([]).size, 0)
  assert.equal(tallyOutcomes(null).size, 0)
  assert.equal(tallyOutcomes(undefined).size, 0)
  assert.equal(tallyOutcomes([{ status: 'open' }, {}]).size, 0)  // all pending
})

// ---- rateOf ----------------------------------------------------------------

test('rateOf: raw engaged share, or null when nothing is decided', () => {
  approx(rateOf({ engaged: 3, ignored: 1 }), 0.75)
  approx(rateOf({ engaged: 0, ignored: 4 }), 0)
  assert.equal(rateOf({ engaged: 0, ignored: 0 }), null)
  assert.equal(rateOf({}), null)
  assert.equal(rateOf(), null)
})

// ---- confidenceOf (the Beta-Bernoulli shrinkage) ---------------------------

test('confidenceOf: NO history → exactly the neutral prior (THE no-op property)', () => {
  // This is the keystone safety guarantee: a brand-new signature, or a whole feed
  // with no lifecycle history, must score 0.5 → weight 1.0 → ranking unchanged.
  assert.equal(confidenceOf({ engaged: 0, ignored: 0 }), 0.5)
  assert.equal(confidenceOf({}), 0.5)
  assert.equal(confidenceOf(), 0.5)
  assert.equal(confidenceOf({ engaged: 0, ignored: 0 }), PRIOR_MEAN)
  assert.equal(weightFor(confidenceOf({ engaged: 0, ignored: 0 })), 1)   // → 1.0, a true no-op
})

test('confidenceOf: posterior mean = (engaged + priorMean·K)/(n + K)', () => {
  // K=6, priorMean=0.5 → prior contributes 3 pseudo-engaged out of 6 pseudo-samples
  approx(confidenceOf({ engaged: 3, ignored: 0 }), 0.667)  // (3+3)/(3+6)=6/9
  approx(confidenceOf({ engaged: 0, ignored: 3 }), 0.333)  // (0+3)/(3+6)=3/9
  approx(confidenceOf({ engaged: 6, ignored: 0 }), 0.75)   // (6+3)/(6+6)=9/12
  approx(confidenceOf({ engaged: 0, ignored: 6 }), 0.25)   // (0+3)/(6+6)=3/12
  approx(confidenceOf({ engaged: 3, ignored: 3 }), 0.5)    // balanced stays neutral
})

test('confidenceOf: shrinks hard at small n, converges to the raw rate at large n', () => {
  // one acted-on alert is NOT "100% useful" — it barely moves off the prior
  approx(confidenceOf({ engaged: 1, ignored: 0 }), 0.571)  // (1+3)/7, not 1.0
  // a long track record earns its true rate
  approx(confidenceOf({ engaged: 100, ignored: 0 }), 0.972) // (100+3)/106 → ~1
  approx(confidenceOf({ engaged: 0, ignored: 100 }), 0.028) // (0+3)/106 → ~0
  // monotone: more engagements never lowers confidence
  assert.ok(confidenceOf({ engaged: 5, ignored: 1 }) > confidenceOf({ engaged: 1, ignored: 5 }))
})

test('confidenceOf: tunable prior — a fleet base rate or weight can be supplied', () => {
  // shrink toward a 0.8 fleet rate instead of 0.5
  approx(confidenceOf({ engaged: 0, ignored: 0 }, { priorMean: 0.8 }), 0.8)
  approx(confidenceOf({ engaged: 3, ignored: 1 }, { priorMean: 0.8 }), 0.78) // (3+0.8*6)/(4+6)=7.8/10
  // K=0 disables shrinkage → the raw rate itself
  approx(confidenceOf({ engaged: 3, ignored: 1 }, { priorWeight: 0 }), 0.75)
  // K=0 AND no data → falls back to the prior mean (no divide-by-zero)
  assert.equal(confidenceOf({ engaged: 0, ignored: 0 }, { priorWeight: 0 }), 0.5)
})

test('confidenceOf: robust to junk — bad counts → 0, bad prior → default, stays in [0,1]', () => {
  approx(confidenceOf({ engaged: '3', ignored: '1' }), 0.6)   // numeric strings coerced
  approx(confidenceOf({ engaged: -5, ignored: 1 }), 0.429)    // negative count → 0 → (0+3)/7
  approx(confidenceOf({ engaged: NaN, ignored: 1 }), 0.429)   // NaN count → 0
  approx(confidenceOf({ engaged: 3, ignored: 1 }, { priorMean: NaN }), 0.6) // bad prior → 0.5
  approx(confidenceOf({ engaged: 3, ignored: 1 }, { priorMean: 2 }), 0.9)   // prior clamped to 1
  const c = confidenceOf({ engaged: 9999, ignored: 0 })
  assert.ok(c >= 0 && c <= 1)
})

// ---- bandOf ----------------------------------------------------------------

test('bandOf: low / medium / high split at the documented thresholds', () => {
  assert.equal(bandOf(0.2), 'low')
  assert.equal(bandOf(0.39), 'low')
  assert.equal(bandOf(BAND_LOW), 'medium')   // 0.40 is the bottom of medium (not low)
  assert.equal(bandOf(0.5), 'medium')
  assert.equal(bandOf(0.65), 'medium')
  assert.equal(bandOf(BAND_HIGH), 'high')    // 0.66 is the bottom of high
  assert.equal(bandOf(0.9), 'high')
  assert.equal(bandOf('nonsense'), 'medium') // non-finite → neutral band
})

// ---- weightFor (the centered feed-rank envelope) ---------------------------

test('weightFor: neutral prior maps to EXACTLY 1.0 (no-op), endpoints to the envelope', () => {
  assert.equal(weightFor(0.5), 1)             // the load-bearing centering
  assert.equal(weightFor(PRIOR_MEAN), 1)
  approx(weightFor(0), WEIGHT_MIN)            // 0.6 — maximal demotion
  approx(weightFor(1), WEIGHT_MAX)            // 1.4 — maximal boost
  approx(weightFor(0.75), 1.2)
  approx(weightFor(0.25), 0.8)
})

test('weightFor: monotone in confidence and clamped into [WEIGHT_MIN, WEIGHT_MAX]', () => {
  assert.ok(weightFor(0.7) > weightFor(0.3))
  approx(weightFor(2), WEIGHT_MAX)            // out-of-range confidence clamped
  approx(weightFor(-1), WEIGHT_MIN)
  assert.equal(weightFor('nonsense'), 1)     // non-finite → neutral 1.0
})

// ---- baseRateOf ------------------------------------------------------------

test('baseRateOf: pools all decided rows into one fleet/client engaged rate', () => {
  const r = baseRateOf([
    { status: 'resolved' }, { status: 'acknowledged' }, // 2 engaged
    { status: 'expired' },  { status: 'expired' },      // 2 ignored
    { status: 'open' },                                 // pending → excluded
  ])
  approx(r.mean, 0.5)   // 2 engaged of 4 decided
  assert.equal(r.n, 4)
})

test('baseRateOf: no decided rows → null mean (caller uses the default prior)', () => {
  assert.deepEqual(baseRateOf([]), { mean: null, n: 0 })
  assert.deepEqual(baseRateOf([{ status: 'open' }]), { mean: null, n: 0 })
  assert.deepEqual(baseRateOf(null), { mean: null, n: 0 })
})

// ---- confidenceTable (the one-call pipeline) -------------------------------

test('confidenceTable: rows → per-signature {confidence, band, weight}, shrunk to base rate', () => {
  const rows = [
    { kind: 'forecast', metric: 'revenue', status: 'resolved' },
    { kind: 'forecast', metric: 'revenue', status: 'resolved' },
    { kind: 'forecast', metric: 'revenue', status: 'acknowledged' },
    { kind: 'forecast', metric: 'revenue', status: 'acknowledged' }, // 4 engaged, 0 ignored
    { kind: 'pacing',   metric: 'spend',   status: 'expired' },
    { kind: 'pacing',   metric: 'spend',   status: 'expired' },      // 0 engaged, 2 ignored
  ]
  // base rate = 4 engaged / 6 decided = 0.667 → the prior every signature shrinks toward
  const table = confidenceTable(rows)
  const fc = table.get('forecast::revenue')
  // (engaged 4 + 0.667*6)/(4+6) = (4+4)/10 = 0.8 → a reliably-acted-on kind gets BOOSTED
  approx(fc.confidence, 0.8)
  assert.equal(fc.band, 'high')
  approx(fc.weight, 1.24)
  assert.equal(fc.engaged, 4); assert.equal(fc.ignored, 0); assert.equal(fc.n, 4)

  const pc = table.get('pacing::spend')
  // (engaged 0 + 0.667*6)/(2+6) = 4/8 = 0.5 → an ignored kind is pulled toward neutral
  approx(pc.confidence, 0.5)
  assert.equal(pc.band, 'medium')
  approx(pc.weight, 1)
})

test('confidenceTable: explicit priorMean overrides the computed base rate', () => {
  const rows = [{ kind: 'anomaly', metric: 'leads', status: 'expired' }]
  // force a neutral 0.5 prior: (0 + 0.5*6)/(1+6) = 3/7 = 0.429
  const table = confidenceTable(rows, { priorMean: 0.5 })
  approx(table.get('anomaly::leads').confidence, 0.429)
})

test('confidenceTable: no history → empty table (nothing to re-rank, a pure no-op)', () => {
  assert.equal(confidenceTable([]).size, 0)
  assert.equal(confidenceTable(null).size, 0)
  assert.equal(confidenceTable([{ status: 'open' }]).size, 0)  // pending only → no signatures
})

// ---- exported constants ----------------------------------------------------

test('constants are the documented, sane values', () => {
  assert.equal(PRIOR_WEIGHT, 6)
  assert.equal(PRIOR_MEAN, 0.5)
  assert.equal(BAND_LOW, 0.40)
  assert.equal(BAND_HIGH, 0.66)
  assert.equal(WEIGHT_MIN, 0.6)
  assert.equal(WEIGHT_MAX, 1.4)
  assert.ok(BAND_LOW < BAND_HIGH)
  assert.ok(WEIGHT_MIN < WEIGHT_MAX)
})
