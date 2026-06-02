'use strict'

// Tests for lib/pulseAccuracy.js — the Daily Pulse's self-audit of its own
// PREDICTIVE precision (distinct from pulseReliability's persistence). The contract:
//   • ACCURACY = does the mid-week early warning predict the COMPLETED week? It
//     replays the SAME dayPulse twice — the early call over the daily series at a
//     lead day (window W), and the ground truth via window:1 over the weekly-totals
//     series (one trailing-1 window IS a week's total) — so there is one definition
//     of "unusual" and the score can't drift from the live sensor or weekly engine;
//   • a confusion matrix over GRADEABLE weeks (both verdicts computable): TP early-
//     fired & week-adverse, FP early-fired & week-fine, FN missed & week-adverse,
//     TN missed & week-fine; precision = TP/(TP+FP), recall = TP/(TP+FN), F1 the
//     harmonic mean, avg_lead_days = mean head-start (W − first-fire-day) over TPs;
//   • FAIR: a week is graded only if the weekly truth is definite AND the early
//     sensor had history to speak — we never score a call the sensor couldn't make;
//   • HONEST BY ABSTENTION: < minWeeks gradeable → 'insufficient_weeks'; no
//     gradeable week at all → 'insufficient_history'; graded but < minFires early
//     warnings → 'insufficient_fires'; precision/recall/f1/label null on those, with
//     the raw confusion tally still reported (so "it warned twice, I need three"
//     stays visible);
//   • divide guards: precision null when no fires (but then we'd have abstained),
//     recall null when there are no adverse weeks to catch, f1 null when either is;
//   • accuracyLabel: proven ≥0.70 · developing 0.40–0.69 · learning <0.40 · null→null
//     (a DIFFERENT vocabulary from reliabilityLabel so the two never get confused);
//   • narratePulseAccuracy turns a GRADED audit into one grounded sentence whose
//     every figure is copied off the grade; the client audience only REINFORCES a
//     proven record and stays silent on developing/learning; '' for un-graded/missing;
//   • PURE: forwards dayPulse's knobs verbatim, never mutates its input, never throws.
//
// FIXTURE NOTE: under the `blocks` builder the daily window-7 early call and the
// window:1 weekly verdict are the SAME computation (identical latest + baseline),
// so they agree by construction — fp=fn=0, a perfect predictor. That makes blocks
// the right tool for the perfect-predictor / abstention / invariant cases. Driving
// a FALSE ALARM or a MISS requires intra-week daily structure (the `seq` builder),
// where the mid-week trailing window and the completed-week total can disagree.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  pulseAccuracy,
  narratePulseAccuracy,
  accuracyLabel,
  DEFAULT_MIN_WEEKS,
  DEFAULT_MIN_FIRES,
} = require('../lib/pulseAccuracy')

// ── builders ────────────────────────────────────────────────────────────────────────────
// blocks([s0, s1, …]) → a dense daily series of 7-day blocks, oldest first, each carrying
// its whole sum on day 0 then zeros. A trailing 7-day window aligned within a block equals
// that block's sum, so the trailing-window total is a step function the test can name week
// by week (same builder dayPulse / pulseReliability use). Because the prior non-overlapping
// 7-windows then equal the prior weekly totals, the daily early call and the window:1
// weekly verdict coincide here — a guaranteed perfect predictor whenever it fires.
const blocks = (sums) => sums.flatMap((s) => [s, 0, 0, 0, 0, 0, 0])
// repeat(val, weeks) → `weeks` identical block-sums, for sustained regimes.
const repeat = (val, weeks) => Array.from({ length: weeks }, () => val)
// week(...days) / seq(...weeks) → explicit intra-week daily structure: lay out each of a
// week's 7 days, concatenate weeks. Lets a fixture put activity EARLY or LATE in a week so
// the mid-week trailing sensor and the completed-week total can legitimately disagree.
const week = (...days) => days
const seq = (...weeks) => weeks.flat()

// ── perfect predictor: a sustained drop the early call and the week always agree on ──────
test('pulseAccuracy: a sustained drop → precision & recall 1.0, full lead time', () => {
  // Many strong weeks then several weak ones. The first weak week sits on an all-strong
  // (zero-variance) baseline → normal both ways (a clean TN); each following weak week
  // breaks the still-high band DOWN. Under blocks the early call IS the weekly verdict, so
  // every firing is a TP and no week is ever a false alarm or a miss — and because the
  // block front-loads its sum, the sensor fires on day 1, the maximum 6-day head-start.
  const r = pulseAccuracy(blocks(repeat(100, 12).concat(repeat(25, 6))), { adverseWhen: 'drop' })
  assert.equal(r.status, 'graded')
  assert.equal(r.reason, 'graded')
  assert.ok(r.fires >= DEFAULT_MIN_FIRES, `enough early warnings (${r.fires})`)
  assert.equal(r.fp, 0, 'never warned on a week that turned out fine')
  assert.equal(r.fn, 0, 'never missed a bad week it could have caught')
  assert.equal(r.tp, r.fires)
  assert.equal(r.precision, 1)
  assert.equal(r.recall, 1)
  assert.equal(r.f1, 1)
  assert.equal(r.avg_lead_days, r.window - 1)   // fires on day 1 of the block → W−1 days early
  assert.equal(r.label, 'proven')
  // invariants
  assert.equal(r.tp + r.fp, r.fires)
  assert.equal(r.tp + r.fn, r.adverse_weeks)
  assert.equal(r.tp + r.fp + r.fn + r.tn, r.weeks_graded)
})

// ── the mirror image: an early sensor that keeps crying wolf ─────────────────────────────
test('pulseAccuracy: a sensor that is wrong every time → graded, precision 0, recall 0, f1 null', () => {
  // A big spike landing on the LAST day of certain weeks. By the lead day the spike's
  // own week has already banked it (the early call, blind to a day-7 surge, MISSES → FN),
  // yet the spike lingers in the mid-week trailing window of the FOLLOWING week and trips
  // the sensor there (the week itself closes fine → FALSE ALARM). With 'either' the sensor
  // fires three times and every call is wrong — the exact off-diagonal mirror of the
  // perfect predictor, proving the confusion matrix populates and the audit refuses to
  // flatter a sensor that has earned no precision.
  const spikey = seq(
    week(10, 10, 10, 10, 10, 10, 10), week(8, 12, 9, 11, 10, 9, 11),
    week(11, 9, 10, 12, 8, 10, 10), week(9, 11, 10, 10, 12, 8, 200),
    week(10, 10, 9, 11, 10, 10, 10), week(12, 8, 11, 9, 10, 11, 9),
    week(10, 11, 9, 10, 8, 12, 200), week(9, 10, 11, 10, 10, 9, 11),
    week(11, 9, 10, 10, 12, 8, 10), week(10, 10, 10, 9, 11, 10, 10),
  )
  const r = pulseAccuracy(spikey, { adverseWhen: 'either' })
  assert.equal(r.status, 'graded')
  assert.ok(r.fires >= DEFAULT_MIN_FIRES, `it fired enough to be graded (${r.fires})`)
  assert.equal(r.tp, 0)
  assert.equal(r.precision, 0)         // every early warning was a false alarm
  assert.equal(r.recall, 0)            // and it missed the week that did close adverse
  assert.equal(r.f1, null)             // precision + recall = 0 → harmonic mean undefined
  assert.equal(r.avg_lead_days, null)  // no true positive → no lead time to report
  assert.equal(r.label, 'learning')    // a 0% record is, charitably, "still learning"
  assert.equal(r.tp + r.fp, r.fires)
  assert.equal(r.tp + r.fn, r.adverse_weeks)
  assert.equal(r.tp + r.fp + r.fn + r.tn, r.weeks_graded)
})

// ── abstention: no gradeable week anywhere ───────────────────────────────────────────────
test('pulseAccuracy: empty / garbage / too-short input → insufficient_history, nulls', () => {
  for (const bad of [undefined, null, [], [1, 2, 3], 'nope', {}, blocks(repeat(100, 3))]) {
    const r = pulseAccuracy(bad, { adverseWhen: 'drop' })
    assert.equal(r.status, 'insufficient')
    assert.equal(r.reason, 'insufficient_history')
    assert.equal(r.weeks_graded, 0)
    assert.equal(r.precision, null)
    assert.equal(r.recall, null)
    assert.equal(r.f1, null)
    assert.equal(r.avg_lead_days, null)
    assert.equal(r.label, null)
    assert.equal(r.window, 7)
    assert.equal(r.lead_day, 5)               // ⌈2·7/3⌉
  }
})

// ── abstention: it graded weeks, but the sensor never warned ─────────────────────────────
test('pulseAccuracy: a flat history → weeks graded but no early warnings → insufficient_fires', () => {
  // Every week ≈ the same level ⇒ z≈0 everywhere ⇒ the sensor never fires and no week ever
  // closes adverse. Plenty of weeks are gradeable (definite verdicts), but with no early
  // warnings there is no precision to report — abstain rather than invent one off zero.
  const r = pulseAccuracy(blocks(repeat(100, 12)), { adverseWhen: 'drop' })
  assert.equal(r.status, 'insufficient')
  assert.equal(r.reason, 'insufficient_fires')
  assert.equal(r.fires, 0)
  assert.equal(r.precision, null)             // the divide-by-zero guard: no fires → null
  assert.equal(r.label, null)
  assert.ok(r.weeks_graded >= DEFAULT_MIN_WEEKS, `it did grade weeks (${r.weeks_graded})`)
})

// ── abstention: enough fires/weeks, but the floor is raised past them ─────────────────────
test('pulseAccuracy: minWeeks raises the abstention floor', () => {
  const series = blocks(repeat(100, 12).concat(repeat(25, 6)))
  const graded = pulseAccuracy(series, { adverseWhen: 'drop' })
  assert.equal(graded.status, 'graded')
  // Demand an impossible number of gradeable weeks → must abstain though it did grade some.
  const strict = pulseAccuracy(series, { adverseWhen: 'drop', minWeeks: 9999 })
  assert.equal(strict.status, 'insufficient')
  assert.equal(strict.reason, 'insufficient_weeks')
  assert.equal(strict.precision, null)
  assert.equal(strict.min_weeks, 9999)
  assert.ok(strict.weeks_graded > 0, 'it still counted the gradeable weeks, just below the floor')
})

test('pulseAccuracy: minFires raises the early-warning floor', () => {
  const series = blocks(repeat(100, 12).concat(repeat(25, 6)))   // fires several times by default
  const strict = pulseAccuracy(series, { adverseWhen: 'drop', minFires: 9999 })
  assert.equal(strict.status, 'insufficient')
  assert.equal(strict.reason, 'insufficient_fires')
  assert.equal(strict.precision, null)
  assert.equal(strict.min_fires, 9999)
  assert.ok(strict.fires > 0, 'it still counted the early warnings, just below the floor')
})

// ── invariants hold across a spread of shapes (the guard net for every edge) ─────────────
test('pulseAccuracy: invariants and divide-guards hold on every shape', () => {
  const shapes = [
    blocks(repeat(100, 12)),                                  // flat
    blocks(repeat(100, 12).concat(repeat(25, 6))),            // sustained drop
    blocks(repeat(40, 5).concat(repeat(120, 8))),             // sustained rise
    blocks([100, 30, 110, 25, 120, 35, 105, 28, 115, 32, 108, 26]), // oscillating weeks
    // intra-week structure: a big spike landing on the LAST day of some weeks, so the
    // completed-week total and the mid-week trailing window legitimately disagree.
    seq(
      week(10, 10, 10, 10, 10, 10, 10), week(8, 12, 9, 11, 10, 9, 11),
      week(11, 9, 10, 12, 8, 10, 10), week(9, 11, 10, 10, 12, 8, 200),
      week(10, 10, 9, 11, 10, 10, 10), week(12, 8, 11, 9, 10, 11, 9),
      week(10, 11, 9, 10, 8, 12, 200), week(9, 10, 11, 10, 10, 9, 11),
      week(11, 9, 10, 10, 12, 8, 10), week(10, 10, 10, 9, 11, 10, 10),
    ),
  ]
  for (const adverseWhen of ['drop', 'spike', 'either']) {
    for (const s of shapes) {
      const r = pulseAccuracy(s, { adverseWhen })
      assert.ok(r.status === 'graded' || r.status === 'insufficient')
      // confusion bookkeeping closes, always
      assert.equal(r.tp + r.fp, r.fires)
      assert.equal(r.tp + r.fn, r.adverse_weeks)
      assert.equal(r.tp + r.fp + r.fn + r.tn, r.weeks_graded)
      assert.ok([r.tp, r.fp, r.fn, r.tn].every((c) => Number.isInteger(c) && c >= 0))
      if (r.status === 'graded') {
        assert.ok(r.fires >= DEFAULT_MIN_FIRES)
        // precision is defined here (graded ⇒ fires ≥ minFires ≥ 1)
        assert.ok(r.precision >= 0 && r.precision <= 1)
        assert.equal(r.precision, r.tp / r.fires)
        assert.equal(r.label, accuracyLabel(r.precision))
        // recall: defined iff there were adverse weeks, else the null guard
        if (r.adverse_weeks > 0) assert.equal(r.recall, r.tp / r.adverse_weeks)
        else assert.equal(r.recall, null)
        // f1: null unless both precision and recall are present and positive
        if (r.recall != null && r.precision + r.recall > 0) {
          assert.ok(r.f1 >= 0 && r.f1 <= 1)
        } else {
          assert.equal(r.f1, null)
        }
        // lead time, when present, is a real head-start in [0, W−1]
        if (r.avg_lead_days != null) {
          assert.ok(r.avg_lead_days >= 0 && r.avg_lead_days <= r.window - 1)
        }
      } else {
        assert.equal(r.precision, null)
        assert.equal(r.recall, null)
        assert.equal(r.f1, null)
        assert.equal(r.label, null)
      }
    }
  }
})

// ── knob plumbing: window / leadDay / floors forwarded and reflected ─────────────────────
test('pulseAccuracy: window & leadDay overrides are reflected', () => {
  const r = pulseAccuracy(blocks(repeat(100, 12).concat(repeat(25, 6))), {
    adverseWhen: 'drop', window: 5, leadDay: 3,
  })
  assert.equal(r.window, 5)
  assert.equal(r.lead_day, 3)
})

test('pulseAccuracy: leadDay defaults to ⌈2W/3⌉ and is clamped to the window', () => {
  assert.equal(pulseAccuracy([], {}).lead_day, 5)                       // ⌈14/3⌉ = 5 for W=7
  assert.equal(pulseAccuracy([], { window: 9 }).lead_day, 6)            // ⌈18/3⌉ = 6 for W=9
  assert.equal(pulseAccuracy([], { window: 5, leadDay: 99 }).lead_day, 5) // clamped to W
})

// ── accuracyLabel: the band thresholds, one source of truth ──────────────────────────────
test('accuracyLabel: thresholds at 0.70 and 0.40, null for un-gradeable', () => {
  assert.equal(accuracyLabel(1), 'proven')
  assert.equal(accuracyLabel(0.7), 'proven')
  assert.equal(accuracyLabel(0.699), 'developing')
  assert.equal(accuracyLabel(0.4), 'developing')
  assert.equal(accuracyLabel(0.399), 'learning')
  assert.equal(accuracyLabel(0), 'learning')
  assert.equal(accuracyLabel(null), null)
  assert.equal(accuracyLabel(undefined), null)
  assert.equal(accuracyLabel(NaN), null)
  assert.equal(accuracyLabel(Infinity), null)
})

// ── narration: grounded, audience-split, silent when nothing trustworthy to say ──────────
test('narratePulseAccuracy: agency sentence copies the figures, lead time and band word', () => {
  const proven = { status: 'graded', precision: 0.8, tp: 8, fires: 10, avg_lead_days: 3, label: 'proven' }
  const sP = narratePulseAccuracy(proven, { label: 'Leads', audience: 'agency' })
  assert.match(sP, /Leads/)
  assert.match(sP, /8 of 10/)
  assert.match(sP, /~80%/)
  assert.match(sP, /about 3 days before it closed/)
  assert.match(sP, /a proven lead/)

  // a single-day head-start reads "1 day", not "1 days"
  const oneDay = { status: 'graded', precision: 0.75, tp: 6, fires: 8, avg_lead_days: 1, label: 'proven' }
  assert.match(narratePulseAccuracy(oneDay, { label: 'Revenue', audience: 'agency' }), /about 1 day before it closed/)

  // learning, and no lead time to report → no "before it closed" clause
  const learning = { status: 'graded', precision: 2 / 7, tp: 2, fires: 7, avg_lead_days: 0, label: 'learning' }
  const sL = narratePulseAccuracy(learning, { label: 'Spend', audience: 'agency' })
  assert.match(sL, /2 of 7/)
  assert.match(sL, /~29%/)
  assert.match(sL, /still learning/)
  assert.doesNotMatch(sL, /before it closed/)

  const developing = { status: 'graded', precision: 0.5, tp: 4, fires: 8, avg_lead_days: 2, label: 'developing' }
  assert.match(narratePulseAccuracy(developing, { audience: 'agency' }), /developing/)
})

test('narratePulseAccuracy: client audience only reinforces a proven record', () => {
  const proven = { status: 'graded', precision: 0.8, tp: 8, fires: 10, avg_lead_days: 3, label: 'proven' }
  const developing = { status: 'graded', precision: 0.5, tp: 4, fires: 8, avg_lead_days: 2, label: 'developing' }
  const learning = { status: 'graded', precision: 0.2, tp: 1, fires: 5, avg_lead_days: 1, label: 'learning' }
  assert.equal(narratePulseAccuracy(proven, { audience: 'client' }), "We've been spotting shifts like this early — and they've usually proven out.")
  assert.equal(narratePulseAccuracy(developing, { audience: 'client' }), '')  // never volunteer a weak record
  assert.equal(narratePulseAccuracy(learning, { audience: 'client' }), '')
})

test('narratePulseAccuracy: silent on un-graded / missing input', () => {
  assert.equal(narratePulseAccuracy(null), '')
  assert.equal(narratePulseAccuracy(undefined), '')
  assert.equal(narratePulseAccuracy({ status: 'insufficient', precision: null }), '')
  assert.equal(narratePulseAccuracy({ status: 'graded', precision: null }), '')
})

// ── purity: input never mutated, never throws ────────────────────────────────────────────
test('pulseAccuracy: does not mutate its input and never throws', () => {
  const src = blocks(repeat(100, 12).concat(repeat(25, 6)))
  const snapshot = src.slice()
  const frozen = Object.freeze(src.slice())
  assert.doesNotThrow(() => pulseAccuracy(frozen, { adverseWhen: 'drop' }))
  pulseAccuracy(src, { adverseWhen: 'drop' })
  assert.deepEqual(src, snapshot)
})
