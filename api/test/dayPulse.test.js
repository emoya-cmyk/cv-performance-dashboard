'use strict'

// Tests for lib/dayPulse.js — the intra-week early-warning sensor. The contract:
//   • the unit of observation is the TRAILING W-day SUM (default 7), recomputed
//     daily, so a mid-week collapse is seen before the ISO week closes;
//   • the latest window is judged against PRIOR NON-OVERLAPPING W-day windows
//     (independent samples, weekday-aligned) and is EXCLUDED from its own band —
//     an extreme latest week can't widen the band meant to catch it;
//   • it reuses baselines' robust median/MAD machinery, so "unusual" means the
//     same thing here as on the weekly series — no second threshold to drift;
//   • SENSE-NEUTRAL by default: it reports a signed direction + severity; the
//     `adverse` flag is set only when the caller declares the metric's bad
//     polarity via adverseWhen ('drop' | 'spike' | 'either');
//   • HONEST BY ABSTENTION: a series shorter than the window, or with fewer than
//     `minWindows` prior windows, returns status:'insufficient' — never a guess;
//   • delta_pct refuses a divide-by-zero (null when the baseline median is 0);
//   • narrateDayPulse turns a SIGNAL into one grounded sentence whose every
//     figure is copied off the verdict (so it can't disagree with the numbers),
//     and falls silent ('') on normal/insufficient/missing verdicts;
//   • PURE: a frozen numeric array in is never mutated, and it never throws.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { dayPulse, narrateDayPulse, DEFAULT_WINDOW, DEFAULT_MIN_WINDOWS } = require('../lib/dayPulse')

// ── builder ───────────────────────────────────────────────────────────────────────────
// blocks([s0, s1, …]) → a dense daily series of 7-day blocks, oldest first, where
// each block carries its whole sum on day 0 and zeros after. The within-block layout
// is irrelevant to a 7-day window SUM, so this lets a test name each week's total
// directly: with the default window, the latest trailing window == the last block's
// sum and each prior non-overlapping window == an earlier block's sum.
const blocks = (sums) => sums.flatMap((s) => [s, 0, 0, 0, 0, 0, 0])

// ── trailing-window selection + the robust band ─────────────────────────────────────────
test('dayPulse: a stable history with an in-band latest week → normal, no severity', () => {
  const v = dayPulse(blocks([90, 100, 110, 95, 105, 100]))
  assert.equal(v.status, 'normal')
  assert.equal(v.severity, null)
  assert.equal(v.latest, 100)
  assert.equal(v.baseline.median, 100)
  assert.equal(v.baseline.n, 5)          // 5 prior weeks, latest excluded
  assert.equal(v.direction, 'flat')
  assert.equal(v.reason, 'within_band')
})

test('dayPulse: a collapsed latest week → critical DROP signal with a negative delta', () => {
  const v = dayPulse(blocks([90, 100, 110, 95, 105, 20]))
  assert.equal(v.status, 'signal')
  assert.equal(v.severity, 'critical')
  assert.equal(v.latest, 20)
  assert.equal(v.baseline.median, 100)
  assert.equal(v.direction, 'down')
  assert.ok(v.z < -3)                    // far below the band
  assert.equal(Math.round(v.delta_pct), -80)
  assert.equal(v.reason, 'out_of_band')
})

test('dayPulse: a runaway latest week → critical SPIKE signal with a positive delta', () => {
  const v = dayPulse(blocks([90, 100, 110, 95, 105, 300]))
  assert.equal(v.status, 'signal')
  assert.equal(v.severity, 'critical')
  assert.equal(v.direction, 'up')
  assert.ok(v.z > 3)
  assert.equal(Math.round(v.delta_pct), 200)
})

test('dayPulse: the latest window is EXCLUDED from its own baseline', () => {
  // 5 prior weeks + the extreme latest → baseline.n must be 5 (the 300 is not in it);
  // were it included, the band would widen toward the outlier and could mask it.
  const v = dayPulse(blocks([90, 100, 110, 95, 105, 300]))
  assert.equal(v.baseline.n, 5)
  assert.equal(v.severity, 'critical')   // still flagged precisely because it's excluded
})

// ── adverse polarity is the caller's to declare ─────────────────────────────────────────
test('dayPulse: sense-neutral by default — a signal is not marked adverse without a polarity', () => {
  const v = dayPulse(blocks([90, 100, 110, 95, 105, 20]))   // a real drop signal…
  assert.equal(v.status, 'signal')
  assert.equal(v.adverse, false)                            // …but no adverseWhen → neutral
})

test('dayPulse: adverseWhen:"drop" marks a DROP adverse, a spike not', () => {
  const drop = dayPulse(blocks([90, 100, 110, 95, 105, 20]), { adverseWhen: 'drop' })
  const spike = dayPulse(blocks([90, 100, 110, 95, 105, 300]), { adverseWhen: 'drop' })
  assert.equal(drop.adverse, true)
  assert.equal(spike.adverse, false)
})

test('dayPulse: adverseWhen:"spike" marks a SPIKE adverse, a drop not', () => {
  const spike = dayPulse(blocks([90, 100, 110, 95, 105, 300]), { adverseWhen: 'spike' })
  const drop = dayPulse(blocks([90, 100, 110, 95, 105, 20]), { adverseWhen: 'spike' })
  assert.equal(spike.adverse, true)
  assert.equal(drop.adverse, false)
})

test('dayPulse: adverseWhen:"either" marks any signal adverse; a normal week never is', () => {
  const sig = dayPulse(blocks([90, 100, 110, 95, 105, 300]), { adverseWhen: 'either' })
  const norm = dayPulse(blocks([90, 100, 110, 95, 105, 100]), { adverseWhen: 'either' })
  assert.equal(sig.adverse, true)
  assert.equal(norm.adverse, false)       // no signal ⇒ never adverse
})

// ── honest abstention ────────────────────────────────────────────────────────────────────
test('dayPulse: a series shorter than the window → insufficient, never a guess', () => {
  const v = dayPulse([1, 2, 3])
  assert.equal(v.status, 'insufficient')
  assert.equal(v.reason, 'series_shorter_than_window')
  assert.equal(v.latest, null)
  assert.equal(v.severity, null)
  assert.equal(v.baseline.n, 0)
})

test('dayPulse: too few prior windows → insufficient (insufficient_history)', () => {
  const v = dayPulse(blocks([100, 110, 90]))    // only 2 prior windows < default minWindows(3)
  assert.equal(v.status, 'insufficient')
  assert.equal(v.reason, 'insufficient_history')
  assert.equal(v.latest, null)
})

test('dayPulse: a non-array or garbage input → insufficient, never throws', () => {
  for (const bad of [undefined, null, {}, 'nope', 42, NaN]) {
    const v = dayPulse(bad)
    assert.equal(v.status, 'insufficient')
    assert.equal(v.severity, null)
    assert.equal(v.adverse, false)
  }
})

test('dayPulse: delta_pct is null (not Infinity/NaN) when the baseline median is 0', () => {
  // prior windows {0,0,0,5} → median 0; a spread still exists (the 5) so a signal can fire,
  // but the percentage gap from a zero median is undefined and must be reported as null.
  const v = dayPulse(blocks([0, 0, 0, 5, 40]))
  assert.equal(v.baseline.median, 0)
  assert.equal(v.status, 'signal')
  assert.equal(v.direction, 'up')
  assert.equal(v.delta_pct, null)
})

// ── the window knob is honored ───────────────────────────────────────────────────────────
test('dayPulse: a custom window changes both the latest window and the baseline windows', () => {
  // 4 non-overlapping 2-day windows: prior sums {18,20,22}, latest 0.
  const series = [11, 11, /*22*/ 10, 10, /*20*/ 9, 9, /*18*/ 0, 0 /*latest 0*/]
  const win2 = dayPulse(series, { window: 2 })
  assert.equal(win2.window, 2)
  assert.equal(win2.status, 'signal')
  assert.equal(win2.latest, 0)
  assert.equal(win2.baseline.median, 20)
  assert.equal(win2.baseline.n, 3)
  assert.equal(win2.direction, 'down')

  // SAME series under the default 7-day window has no room for a prior window → abstains.
  const win7 = dayPulse(series)
  assert.equal(win7.window, DEFAULT_WINDOW)
  assert.equal(win7.status, 'insufficient')
  assert.equal(win7.reason, 'insufficient_history')
})

test('dayPulse: minWindows is configurable', () => {
  // 2 prior windows {110,100} (median 105) + an in-band latest 105: default
  // minWindows(3) abstains, minWindows:2 judges it and finds it normal.
  const series = blocks([100, 110, 105])
  assert.equal(dayPulse(series).status, 'insufficient')
  assert.equal(dayPulse(series, { minWindows: 2 }).status, 'normal')
  assert.equal(DEFAULT_MIN_WINDOWS, 3)
})

// ── narrateDayPulse: one grounded sentence, figures copied off the verdict ────────────────
test('narrateDayPulse: a DROP signal names the trailing total, the gap and the baseline (agency)', () => {
  const v = dayPulse(blocks([90, 100, 110, 95, 105, 20]))
  assert.equal(
    narrateDayPulse(v, { label: 'Leads', audience: 'agency' }),
    "Leads over the last 7 days total 20 — about 80% below this client's usual week (≈100). Flagged today.",
  )
})

test('narrateDayPulse: client tone says "your"; a SPIKE reads "above" and formats thousands', () => {
  const v = dayPulse(blocks([2700, 3000, 3300, 2850, 3150, 5400]))
  assert.equal(
    narrateDayPulse(v, { label: 'Ad spend', audience: 'client' }),
    'Ad spend over the last 7 days total 5,400 — about 80% above your usual week (≈3,000). Flagged today.',
  )
})

test('narrateDayPulse: normal / insufficient / missing verdicts narrate to empty string', () => {
  assert.equal(narrateDayPulse(dayPulse(blocks([90, 100, 110, 95, 105, 100])), { label: 'Leads' }), '')
  assert.equal(narrateDayPulse(dayPulse([1, 2, 3]), { label: 'Leads' }), '')
  assert.equal(narrateDayPulse(null), '')
  assert.equal(narrateDayPulse(undefined), '')
})

// ── purity ────────────────────────────────────────────────────────────────────────────────
test('dayPulse: does not mutate its input (a frozen array is safe)', () => {
  const series = Object.freeze(blocks([90, 100, 110, 95, 105, 20]))
  const v = dayPulse(series, { adverseWhen: 'drop' })   // frozen → throws if it writes
  assert.equal(v.status, 'signal')
  assert.equal(v.adverse, true)
  assert.equal(series.length, 42)                       // untouched
})
