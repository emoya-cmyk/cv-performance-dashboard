// ============================================================
// test/selftune.test.js — the self-IMPROVING half of the intelligence layer.
//
// lib/selftune.js grades every published month-end projection three ways at once
// (model vs naive-market vs realized truth), rolls a client's graded history into
// a TRUST score, and from trust derives that client's own forecast gates plus a
// projection bias-correction factor. Nobody tunes a threshold by hand — the data
// does it. These tests pin: the error math (sign convention + null guards), the
// model-beat-naive scoreboard (independent null skips, win-rate only over the
// decidable rows), and the trust→calibration mapping (neutral below the sample
// floor, tighter gates as trust rises, bias correction that pulls future
// projections toward where this client's have actually landed — clamped + shrunk
// so one freak month can't blow up a number). Pure functions: no DB, no clock.
// ============================================================

'use strict'

const { test } = require('node:test')
const assert   = require('node:assert/strict')

const {
  absPctError, signedPctError, gradeOne, scoreboardOf, calibrationFor,
  SAMPLES_MIN, FC_WARN_DEFAULT, FC_CRIT_DEFAULT,
} = require('../lib/selftune')

const approx = (a, b, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b}`)

// ---- absPctError -----------------------------------------------------------

test('absPctError: magnitude of the miss as a fraction of actual', () => {
  approx(absPctError(150, 100), 0.5)        // 50% over
  approx(absPctError(50, 100), 0.5)         // 50% under — still a 0.5 *absolute* error
  approx(absPctError(100, 100), 0)          // bullseye
  approx(absPctError(120, 80), 0.5)         // |120-80|/80
})

test('absPctError: undefined where the percentage cannot exist → null', () => {
  assert.equal(absPctError(100, 0), null)        // divide-by-zero actual
  assert.equal(absPctError(NaN, 100), null)      // non-finite projection
  assert.equal(absPctError(100, null), null)     // missing actual
  assert.equal(absPctError(undefined, 100), null)
  assert.equal(absPctError(100, Infinity), null) // non-finite actual
})

// ---- signedPctError --------------------------------------------------------

test('signedPctError: positive == OVER-projected, negative == under', () => {
  approx(signedPctError(150, 100), 0.5)     // predicted MORE than reality → +
  approx(signedPctError(50, 100), -0.5)     // predicted LESS than reality → −
  approx(signedPctError(100, 100), 0)
})

test('signedPctError: same null guards as absPctError', () => {
  assert.equal(signedPctError(100, 0), null)
  assert.equal(signedPctError(NaN, 100), null)
  assert.equal(signedPctError(100, undefined), null)
})

// ---- gradeOne --------------------------------------------------------------

test('gradeOne: model crushes naive → model_won true, errors + bias reported', () => {
  // projected 3900 vs actual 4000 (tiny miss); naive 3000 (big miss)
  const g = gradeOne({ projected: 3900, naive: 3000, actual: 4000, target: 8000 })
  approx(g.abs_pct_error, 0.025)            // |3900-4000|/4000
  approx(g.naive_abs_pct_error, 0.25)       // |3000-4000|/4000
  approx(g.bias, -0.025)                    // under-projected → negative
  assert.equal(g.model_won, true)
})

test('gradeOne: naive wins → model_won false', () => {
  // projected 10000 (wild over) vs actual 4000; naive 5000 (closer)
  const g = gradeOne({ projected: 10000, naive: 5000, actual: 4000 })
  approx(g.abs_pct_error, 1.5)
  approx(g.naive_abs_pct_error, 0.25)
  approx(g.bias, 1.5)                       // over-projected → positive
  assert.equal(g.model_won, false)
})

test('gradeOne: a tie counts as a model win (smarter method not penalised)', () => {
  // both 100 off in opposite directions → equal abs error
  const g = gradeOne({ projected: 4100, naive: 3900, actual: 4000 })
  approx(g.abs_pct_error, 0.025)
  approx(g.naive_abs_pct_error, 0.025)
  assert.equal(g.model_won, true)           // ape <= nape, tie → model
})

test('gradeOne: ungradeable month (actual 0 or missing) → nulls, model_won null', () => {
  const g = gradeOne({ projected: 4000, naive: 3000, actual: 0 })
  assert.equal(g.abs_pct_error, null)
  assert.equal(g.naive_abs_pct_error, null)
  assert.equal(g.bias, null)
  assert.equal(g.model_won, null)           // head-to-head undecidable

  // one side decidable, the other not → still no decision
  const g2 = gradeOne({ projected: NaN, naive: 3000, actual: 4000 })
  assert.equal(g2.abs_pct_error, null)
  approx(g2.naive_abs_pct_error, 0.25)      // naive error still computable
  assert.equal(g2.model_won, null)
})

// ---- scoreboardOf ----------------------------------------------------------

test('scoreboardOf: rolls graded rows into a track record', () => {
  const sb = scoreboardOf([
    { abs_pct_error: 0.1, naive_abs_pct_error: 0.2, bias: 0.1, model_won: true },
    { abs_pct_error: 0.3, naive_abs_pct_error: 0.2, bias: -0.3, model_won: false },
  ])
  assert.equal(sb.samples, 2)
  approx(sb.mape, 0.2)                       // (0.1+0.3)/2
  approx(sb.naive_mape, 0.2)
  approx(sb.bias, -0.1)                      // (0.1−0.3)/2
  approx(sb.win_rate, 0.5)                   // one win, one loss
})

test('scoreboardOf: only finite abs_pct_error rows count as samples', () => {
  const sb = scoreboardOf([
    { abs_pct_error: 0.1, naive_abs_pct_error: 0.2, bias: 0.1, model_won: true },
    { abs_pct_error: null, naive_abs_pct_error: 0.9, bias: 0.5, model_won: null }, // dropped
  ])
  assert.equal(sb.samples, 1)
  approx(sb.mape, 0.1)
})

test('scoreboardOf: each aggregate skips ITS OWN nulls independently', () => {
  const sb = scoreboardOf([
    { abs_pct_error: 0.1, naive_abs_pct_error: null, bias: 0.1, model_won: null },
    { abs_pct_error: 0.3, naive_abs_pct_error: 0.4,  bias: null, model_won: true },
  ])
  assert.equal(sb.samples, 2)               // both have finite ape
  approx(sb.mape, 0.2)
  approx(sb.naive_mape, 0.4)                 // first naive null skipped
  approx(sb.bias, 0.1)                       // second bias null skipped
  approx(sb.win_rate, 1)                     // only the decidable row (a win)
})

test('scoreboardOf: nothing gradeable → neutral, all-null aggregates', () => {
  const empty = scoreboardOf([])
  assert.deepEqual(empty, { samples: 0, mape: null, naive_mape: null, win_rate: null, bias: null })
  // a row with no finite ape is filtered out entirely
  assert.equal(scoreboardOf([{ abs_pct_error: null }]).samples, 0)
  assert.equal(scoreboardOf(null).samples, 0)
})

// ---- calibrationFor --------------------------------------------------------

test('calibrationFor: below the sample floor → engine defaults (a pure no-op)', () => {
  const c = calibrationFor({ samples: 1, mape: 0.1, win_rate: 1, bias: 0.5 })
  assert.equal(c.samples, 1)
  assert.equal(c.warn_ratio, FC_WARN_DEFAULT)   // 0.9
  assert.equal(c.crit_ratio, FC_CRIT_DEFAULT)   // 0.7
  assert.equal(c.bias_factor, 1)                // no correction yet
  assert.equal(c.trust, 0.5)                    // neutral
  approx(c.mape, 0.1)
  assert.ok(SAMPLES_MIN >= 2)
})

test('calibrationFor: an empty scoreboard is neutral with a null mape', () => {
  const c = calibrationFor(scoreboardOf([]))
  assert.equal(c.samples, 0)
  assert.equal(c.warn_ratio, 0.9)
  assert.equal(c.crit_ratio, 0.7)
  assert.equal(c.bias_factor, 1)
  assert.equal(c.mape, null)
})

test('calibrationFor: an accurate, trustworthy client earns TIGHT gates', () => {
  // mape 0.04 (near-perfect), wins every head-to-head, barely biased
  const c = calibrationFor({ samples: 6, mape: 0.04, naive_mape: 0.3, win_rate: 1, bias: 0.02 })
  approx(c.trust, 0.952)        // 0.6*0.92 skill + 0.4*1 win
  approx(c.warn_ratio, 0.917)  // lerp(0.85,0.92,trust) — earlier alarm
  approx(c.crit_ratio, 0.743)  // lerp(0.60,0.75,trust)
  approx(c.bias_factor, 0.98)  // 1/(1.02), full strength at 6 samples
  assert.equal(c.samples, 6)
  approx(c.mape, 0.04)
  // tighter than the engine defaults
  assert.ok(c.warn_ratio > FC_WARN_DEFAULT)
  assert.ok(c.crit_ratio > FC_CRIT_DEFAULT)
})

test('calibrationFor: a noisy, unreliable client earns WIDE gates', () => {
  const c = calibrationFor({ samples: 3, mape: 0.45, naive_mape: 0.4, win_rate: 0.3, bias: 0.3 })
  approx(c.trust, 0.18)        // 0.6*0.1 skill + 0.4*0.3 win
  approx(c.warn_ratio, 0.863) // must miss harder before we cry wolf
  approx(c.crit_ratio, 0.627)
  approx(c.bias_factor, 0.827) // 1/(1.3), shrunk by conf 3/4
  // wider than the engine defaults
  assert.ok(c.warn_ratio < FC_WARN_DEFAULT)
  assert.ok(c.crit_ratio < FC_CRIT_DEFAULT)
})

test('calibrationFor: persistent UNDER-projection is corrected UPWARD', () => {
  // bias −0.2 (we keep predicting low) → pull future projections up
  const c = calibrationFor({ samples: 4, mape: 0.1, win_rate: 0.5, bias: -0.2 })
  approx(c.bias_factor, 1.25)   // 1/(1−0.2), full strength at 4 samples
  assert.ok(c.bias_factor > 1)
})

test('calibrationFor: bias correction is shrunk toward 1 below full confidence', () => {
  // same +0.3 bias at 2 samples (conf 0.5) is gentler than at 4 (conf 1.0)
  const low  = calibrationFor({ samples: 2, mape: 0.2, win_rate: 0.5, bias: 0.3 })
  const full = calibrationFor({ samples: 4, mape: 0.2, win_rate: 0.5, bias: 0.3 })
  approx(full.bias_factor, 0.769)               // 1/1.3
  approx(low.bias_factor, 0.885)                // 1 + (0.769−1)*0.5
  assert.ok(low.bias_factor > full.bias_factor) // less sample → closer to 1
})

test('calibrationFor: a wild bias is clamped so one freak month cannot explode', () => {
  // (1 + bias) <= 0 would invert the sign → raw pinned to BIAS_MAX, then clamped
  const c = calibrationFor({ samples: 8, mape: 0.2, win_rate: 0.5, bias: -1.6 })
  assert.equal(c.bias_factor, 1.5)              // BIAS_MAX ceiling
})

test('calibrationFor: an absent win_rate defaults to 0.5 (no head-to-head signal)', () => {
  const c = calibrationFor({ samples: 5, mape: 0.1, win_rate: null, bias: 0 })
  // skill = 1 − 0.1/0.5 = 0.8; trust = 0.6*0.8 + 0.4*0.5 = 0.68
  approx(c.trust, 0.68)
  approx(c.bias_factor, 1)                       // zero bias → no correction
})
