'use strict'

// Tests for lib/pulseReliability.js — the Daily Pulse's self-grading reliability
// score. The contract:
//   • RELIABILITY = PERSISTENCE: it replays dayPulse over the history and, for
//     each position that FIRED, asks whether the SAME-DIRECTION signal is still
//     firing one HORIZON (⌈W/2⌉ = 4 for W=7) later — corroborated vs reverted;
//   • reliability = corroborated / fires, with the invariant corroborated +
//     reverts === fires at all times;
//   • MATURITY: a firing in the last `horizon` days has no future to grade
//     against and is EXCLUDED from the denominator — the score reflects only
//     matured firings (a true track record);
//   • HONEST BY ABSTENTION: never enough history to judge anywhere →
//     status:'insufficient'/reason:'insufficient_history'; judged but fired fewer
//     than minFires matured times → 'insufficient'/'insufficient_fires';
//     reliability:null in both — never a guess off one or two firings;
//   • reliabilityLabel: reliable ≥0.70 · mixed 0.40–0.69 · noisy <0.40 · null→null;
//   • narratePulseReliability turns a GRADED score into one grounded sentence whose
//     every figure is copied off the score; the client audience only REINFORCES a
//     reliable signal and stays silent on mixed/noisy; '' for un-graded/missing;
//   • PURE: forwards dayPulse's knobs verbatim so it grades the SAME firings the
//     live sensor raises, never mutates its input, and never throws.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  pulseReliability,
  narratePulseReliability,
  reliabilityLabel,
  DEFAULT_MIN_FIRES,
} = require('../lib/pulseReliability')

// ── builder ───────────────────────────────────────────────────────────────────────────
// blocks([s0, s1, …]) → a dense daily series of 7-day blocks, oldest first, each block
// carrying its whole sum on day 0 then zeros. A trailing 7-day window aligned within a
// block equals that block's sum, so as the replay steps day by day the trailing-window
// SUM is a step function — constant across each block, jumping at block boundaries —
// which lets a test name each week's total directly (same builder dayPulse's tests use).
const blocks = (sums) => sums.flatMap((s) => [s, 0, 0, 0, 0, 0, 0])
// repeat(val, weeks) → `weeks` identical block-sums, for sustained regimes.
const repeat = (val, weeks) => Array.from({ length: weeks }, () => val)

// ── abstention: too little history anywhere ─────────────────────────────────────────────
test('pulseReliability: empty / garbage / sub-window input → insufficient_history, reliability null', () => {
  for (const bad of [undefined, null, [], [1, 2, 3], 'nope', {}]) {
    const r = pulseReliability(bad)
    assert.equal(r.status, 'insufficient')
    assert.equal(r.reason, 'insufficient_history')
    assert.equal(r.reliability, null)
    assert.equal(r.label, null)
    assert.equal(r.fires, 0)
    assert.equal(r.corroborated, 0)
    assert.equal(r.reverts, 0)
    assert.equal(r.n_positions, 0)
    assert.equal(r.window, 7)
    assert.equal(r.horizon, 4)            // ⌈7/2⌉
  }
})

// ── abstention: it judged, but the sensor never (or rarely) fired ───────────────────────
test('pulseReliability: a flat history → judged but no firings → insufficient_fires', () => {
  // Every week ≈ the same level ⇒ z≈0 at every position ⇒ never a signal. A sensor
  // that has never spoken for this client has no track record to grade.
  const r = pulseReliability(blocks(repeat(100, 7)))
  assert.equal(r.status, 'insufficient')
  assert.equal(r.reason, 'insufficient_fires')
  assert.equal(r.reliability, null)
  assert.equal(r.label, null)
  assert.equal(r.fires, 0)
  assert.ok(r.n_positions > 0, 'it produced definite (normal) verdicts at many positions')
})

// ── maturity gate: every firing is too recent to grade ──────────────────────────────────
test('pulseReliability: firings only in the final horizon → excluded → insufficient_fires', () => {
  // Five calm weeks, then the level craters across just the last 3 appended days, so the
  // trailing-week sum only breaks the band at the very end. Those down-firings sit inside
  // the last `horizon` positions → no matured future to judge → none counted.
  const series = blocks(repeat(100, 5)).concat([0, 0, 0])
  const r = pulseReliability(series)
  assert.equal(r.status, 'insufficient')
  assert.equal(r.reason, 'insufficient_fires')
  assert.equal(r.fires, 0)               // the late firings are ungradeable, not counted against
  assert.equal(r.reliability, null)
  assert.ok(r.n_positions > 0)
})

// ── corroboration path: a sustained shift that keeps firing same-direction ───────────────
test('pulseReliability: a long sustained drop → reliable (firings hold up)', () => {
  // 8 strong weeks then 8 weak weeks. Across the whole weak stretch the trailing week is
  // far below the still-high band, so the sensor fires DOWN at position after position;
  // each firing's look-ahead is also a DOWN firing ⇒ corroborated ⇒ a reliable track record.
  const r = pulseReliability(blocks(repeat(100, 8).concat(repeat(25, 8))))
  assert.equal(r.status, 'graded')
  assert.equal(r.reason, 'graded')
  assert.ok(r.fires >= DEFAULT_MIN_FIRES, `enough matured firings (${r.fires})`)
  assert.ok(r.reliability >= 0.7, `held up most of the time (${r.reliability})`)
  assert.equal(r.label, 'reliable')
  // invariants
  assert.equal(r.corroborated + r.reverts, r.fires)
  assert.equal(r.reliability, r.corroborated / r.fires)
  assert.ok(r.corroborated >= 1)
})

// ── revert path: a lone spike that doesn't persist → some firings revert ────────────────
test('pulseReliability: an isolated spike → reverts present, 0 < reliability < 1', () => {
  // A baseline that WIGGLES (95–110) so its prior windows have real spread — a dead-flat
  // baseline has zero variance and nothing ever clears the band (the flat-series guard).
  // Against that band one 300 week fires UP hard, then the level returns to baseline.
  // Maturity makes the spike a MIXED signal: within its own 7-day block the early
  // positions mature into still-firing days (corroborated), while the later positions
  // mature a horizon on into the calm week after it (reverted). One isolated firing block
  // therefore lands part-held, part-reverted — exactly the "read it with care" case.
  const r = pulseReliability(blocks([100, 110, 95, 105, 98, 107, 300, 100, 105, 95, 102, 100]))
  assert.equal(r.status, 'graded')
  assert.ok(r.fires >= DEFAULT_MIN_FIRES, `enough matured firings (${r.fires})`)
  assert.ok(r.corroborated >= 1, 'some firings held up (matured within the spike block)')
  assert.ok(r.reverts >= 1, 'some firings reverted (matured into the calm week after)')
  assert.ok(r.reliability > 0 && r.reliability < 1, `mixed track record (${r.reliability})`)
  assert.equal(r.corroborated + r.reverts, r.fires)
  assert.equal(r.reliability, r.corroborated / r.fires)
})

// ── invariants hold across a spread of shapes ───────────────────────────────────────────
test('pulseReliability: invariants hold on every shape', () => {
  const shapes = [
    blocks(repeat(100, 7)),                                   // flat
    blocks(repeat(100, 8).concat(repeat(25, 8))),             // sustained drop
    blocks(repeat(40, 4).concat(repeat(120, 6))),             // sustained rise
    blocks([100, 20, 110, 30, 120, 25, 105, 35, 115, 22]),    // oscillating weeks
    blocks([100, 110, 95, 105, 98, 107, 300, 100, 105, 95, 102, 100]), // isolated spike on a live band
  ]
  for (const s of shapes) {
    const r = pulseReliability(s)
    assert.ok(r.status === 'graded' || r.status === 'insufficient')
    assert.equal(r.corroborated + r.reverts, r.fires)        // bookkeeping closes
    assert.ok(r.corroborated >= 0 && r.reverts >= 0 && r.fires >= 0)
    if (r.status === 'graded') {
      assert.ok(r.fires >= DEFAULT_MIN_FIRES)
      assert.ok(r.reliability >= 0 && r.reliability <= 1)
      assert.equal(r.reliability, r.corroborated / r.fires)
      assert.equal(r.label, reliabilityLabel(r.reliability))
    } else {
      assert.equal(r.reliability, null)
      assert.equal(r.label, null)
    }
  }
})

// ── knob plumbing: window / horizon / minFires forwarded and honored ─────────────────────
test('pulseReliability: window & horizon overrides are reflected', () => {
  const r = pulseReliability(blocks(repeat(100, 8).concat(repeat(25, 8))), { window: 5, horizon: 2 })
  assert.equal(r.window, 5)
  assert.equal(r.horizon, 2)
})

test('pulseReliability: minFires raises the abstention floor', () => {
  const series = blocks(repeat(100, 8).concat(repeat(25, 8)))   // fires plenty by default
  const graded = pulseReliability(series)
  assert.equal(graded.status, 'graded')
  // Demand an impossibly high firing count → must abstain even though it did fire.
  const strict = pulseReliability(series, { minFires: 9999 })
  assert.equal(strict.status, 'insufficient')
  assert.equal(strict.reason, 'insufficient_fires')
  assert.equal(strict.reliability, null)
  assert.equal(strict.min_fires, 9999)
  assert.ok(strict.fires > 0, 'it still counted the matured firings, just below the floor')
})

// ── reliabilityLabel: the band thresholds, one source of truth ──────────────────────────
test('reliabilityLabel: thresholds at 0.70 and 0.40, null for un-gradeable', () => {
  assert.equal(reliabilityLabel(1), 'reliable')
  assert.equal(reliabilityLabel(0.7), 'reliable')
  assert.equal(reliabilityLabel(0.699), 'mixed')
  assert.equal(reliabilityLabel(0.4), 'mixed')
  assert.equal(reliabilityLabel(0.399), 'noisy')
  assert.equal(reliabilityLabel(0), 'noisy')
  assert.equal(reliabilityLabel(null), null)
  assert.equal(reliabilityLabel(undefined), null)
  assert.equal(reliabilityLabel(NaN), null)
  assert.equal(reliabilityLabel(Infinity), null)
})

// ── narration: grounded, audience-split, silent when nothing trustworthy to say ──────────
test('narratePulseReliability: agency sentence copies the figures and the band word', () => {
  const reliable = { status: 'graded', reliability: 0.9, corroborated: 9, fires: 10, label: 'reliable' }
  const sR = narratePulseReliability(reliable, { label: 'Leads', audience: 'agency' })
  assert.match(sR, /Leads/)
  assert.match(sR, /9 of 10/)
  assert.match(sR, /~90%/)
  assert.match(sR, /a reliable signal/)

  const noisy = { status: 'graded', reliability: 1 / 3, corroborated: 2, fires: 6, label: 'noisy' }
  const sN = narratePulseReliability(noisy, { label: 'Ad spend', audience: 'agency' })
  assert.match(sN, /2 of 6/)
  assert.match(sN, /~33%/)
  assert.match(sN, /a noisy signal, read it with care/)

  const mixed = { status: 'graded', reliability: 0.5, corroborated: 3, fires: 6, label: 'mixed' }
  assert.match(narratePulseReliability(mixed, { audience: 'agency' }), /a mixed signal/)
})

test('narratePulseReliability: client audience only reinforces a reliable signal', () => {
  const reliable = { status: 'graded', reliability: 0.9, corroborated: 9, fires: 10, label: 'reliable' }
  const mixed = { status: 'graded', reliability: 0.5, corroborated: 3, fires: 6, label: 'mixed' }
  const noisy = { status: 'graded', reliability: 0.2, corroborated: 1, fires: 5, label: 'noisy' }
  assert.equal(narratePulseReliability(reliable, { audience: 'client' }), 'This has been a consistent signal lately.')
  assert.equal(narratePulseReliability(mixed, { audience: 'client' }), '')   // never volunteer doubt to the client
  assert.equal(narratePulseReliability(noisy, { audience: 'client' }), '')
})

test('narratePulseReliability: silent on un-graded / missing input', () => {
  assert.equal(narratePulseReliability(null), '')
  assert.equal(narratePulseReliability(undefined), '')
  assert.equal(narratePulseReliability({ status: 'insufficient', reliability: null }), '')
  assert.equal(narratePulseReliability({ status: 'graded', reliability: null }), '')
})

// ── purity: input never mutated, never throws ───────────────────────────────────────────
test('pulseReliability: does not mutate its input and never throws', () => {
  const src = blocks(repeat(100, 8).concat(repeat(25, 8)))
  const snapshot = src.slice()
  const frozen = Object.freeze(src.slice())
  assert.doesNotThrow(() => pulseReliability(frozen))
  // a fresh equal array passed alongside must come back unchanged
  pulseReliability(src)
  assert.deepEqual(src, snapshot)
})
