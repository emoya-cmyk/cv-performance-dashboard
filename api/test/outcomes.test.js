// ============================================================
// test/outcomes.test.js — recovery classification (lib/outcomes.js)
//
// classifyRecovery() decides whether an about-to-expire finding cleared because the
// problem RECOVERED (a win) vs merely LAPSED (aged out, no proof). These tests pin every
// gate: coverage_gap reconnect, metric-returned-to-baseline (direction-agnostic, with the
// recoverFrac band + its override), the unmeasurable/garbage-probe fall-throughs to a safe
// 'lapsed', the float-exact boundary (the reason the impl carries an epsilon), recoveryPct
// rounding, the kinds we refuse to judge, the exact verdict shapes, and the PURITY contract
// (inputs are never mutated — the caller stamps the result). Pure: no DB, no clock, no LLM.
// ============================================================

'use strict'

const { test } = require('node:test')
const assert   = require('node:assert/strict')

const { classifyRecovery, RECOVERABLE_SYMPTOM_KINDS } = require('../lib/outcomes')

// A metric symptom (anomaly/trend) the engine emits, trimmed to what outcomes reads.
function sym(metric, { kind = 'anomaly', direction = 'down' } = {}) {
  return {
    kind, metric, scope: 'client', severity: 'warning', direction,
    score: 2, period_start: '2026-05-25', evidence: { value: 1, baseline: 2 },
  }
}

// A dark-channel finding (a coverage_gap), trimmed to what outcomes reads.
function cov(channel = 'google_ads') {
  return {
    kind: 'coverage_gap', metric: null, scope: 'client', severity: 'warning',
    direction: 'down', score: 10, evidence: { channel, channel_label: channel, days_dark: 6 },
  }
}

// ── exported symptom set ──────────────────────────────────────────────────
test('RECOVERABLE_SYMPTOM_KINDS is exactly {anomaly, trend}', () => {
  assert.ok(RECOVERABLE_SYMPTOM_KINDS.has('anomaly'))
  assert.ok(RECOVERABLE_SYMPTOM_KINDS.has('trend'))
  for (const k of ['forecast', 'pacing', 'benchmark', 'coverage_gap', 'data_health']) {
    assert.equal(RECOVERABLE_SYMPTOM_KINDS.has(k), false, `${k} must not be recoverable-symptom`)
  }
  assert.equal(RECOVERABLE_SYMPTOM_KINDS.size, 2)
})

// ── degenerate input → safe lapsed ─────────────────────────────────────────
test('null / non-object finding → lapsed no_finding, no throw', () => {
  for (const bad of [null, undefined, 'nope', 42]) {
    const v = classifyRecovery(bad, { current: 1, baseline: 1 })
    assert.equal(v.outcome, 'lapsed')
    assert.equal(v.recovered, false)
    assert.equal(v.reason, 'no_finding')
    assert.equal(v.kind, null)
    assert.equal(v.metric, null)
  }
})

// ── coverage_gap ────────────────────────────────────────────────────────────
test('coverage_gap + probe.fresh:true → recovered (channel_reconnected)', () => {
  const v = classifyRecovery(cov('google_ads'), { fresh: true })
  assert.equal(v.outcome, 'recovered')
  assert.equal(v.recovered, true)
  assert.equal(v.reason, 'channel_reconnected')
  assert.equal(v.kind, 'coverage_gap')
  // a coverage_gap carries no metric/baseline/current to report
  assert.equal(v.metric, null)
  assert.equal(v.baseline, null)
  assert.equal(v.current, null)
  assert.equal(v.recoveryPct, null)
})

test('coverage_gap still dark (fresh:false) → lapsed channel_still_dark', () => {
  const v = classifyRecovery(cov(), { fresh: false })
  assert.equal(v.outcome, 'lapsed')
  assert.equal(v.recovered, false)
  assert.equal(v.reason, 'channel_still_dark')
})

test('coverage_gap with no probe / no fresh key → lapsed no_recovery_signal', () => {
  assert.equal(classifyRecovery(cov(), null).reason, 'no_recovery_signal')
  assert.equal(classifyRecovery(cov(), {}).reason, 'channel_still_dark') // probe present but fresh!==true
})

test('coverage_gap fresh must be strictly true (truthy is not enough)', () => {
  for (const f of [1, 'yes', 'true', {}]) {
    const v = classifyRecovery(cov(), { fresh: f })
    assert.equal(v.outcome, 'lapsed', `fresh:${JSON.stringify(f)} must not count as reconnected`)
  }
})

// ── metric symptom: returned to baseline ────────────────────────────────────
test('down symptom climbed back within band → recovered, recoveryPct ~100', () => {
  const v = classifyRecovery(sym('leads'), { baseline: 100, current: 95 })
  assert.equal(v.outcome, 'recovered')
  assert.equal(v.recovered, true)
  assert.equal(v.reason, 'metric_returned_to_baseline')
  assert.equal(v.kind, 'anomaly')
  assert.equal(v.metric, 'leads')
  assert.equal(v.baseline, 100)
  assert.equal(v.current, 95)
  assert.equal(v.recoveryPct, 95)
})

test('down symptom still depressed → lapsed still_off_baseline, pct reported', () => {
  const v = classifyRecovery(sym('leads'), { baseline: 100, current: 60 })
  assert.equal(v.outcome, 'lapsed')
  assert.equal(v.recovered, false)
  assert.equal(v.reason, 'still_off_baseline')
  assert.equal(v.baseline, 100)
  assert.equal(v.current, 60)
  assert.equal(v.recoveryPct, 60)
})

test('recovery is direction-agnostic: a spike that settled back is recovered', () => {
  // CPL rose (an "up" adverse symptom); it has settled back to ~baseline.
  const v = classifyRecovery(sym('cpl', { direction: 'up' }), { baseline: 50, current: 52 })
  assert.equal(v.outcome, 'recovered')
  assert.equal(v.reason, 'metric_returned_to_baseline')
  assert.equal(v.recoveryPct, 104)
})

test('a spike still elevated → lapsed still_off_baseline', () => {
  const v = classifyRecovery(sym('cpl', { direction: 'up' }), { baseline: 50, current: 80 })
  assert.equal(v.outcome, 'lapsed')
  assert.equal(v.reason, 'still_off_baseline')
  assert.equal(v.recoveryPct, 160)
})

test('trend kind is recoverable just like anomaly', () => {
  const v = classifyRecovery(sym('revenue', { kind: 'trend' }), { baseline: 200, current: 192 })
  assert.equal(v.outcome, 'recovered')
  assert.equal(v.kind, 'trend')
})

// ── float-exact boundary (the reason for the epsilon) ───────────────────────
test('exact 10% gap is INCLUSIVE at default recoverFrac (epsilon guard)', () => {
  // 1 - 0.9 === 0.09999999999999998 in IEEE-754; without the epsilon a true 0.1 gap
  // would wrongly miss the `<=`. Both edges of the band must classify as recovered.
  assert.equal(classifyRecovery(sym('m'), { baseline: 100, current: 110 }).outcome, 'recovered') // +10%
  assert.equal(classifyRecovery(sym('m'), { baseline: 100, current: 90 }).outcome, 'recovered')  // -10%
  // a hair beyond the band is lapsed
  assert.equal(classifyRecovery(sym('m'), { baseline: 100, current: 111 }).outcome, 'lapsed')
  assert.equal(classifyRecovery(sym('m'), { baseline: 100, current: 89 }).outcome, 'lapsed')
})

// ── recoverFrac override ────────────────────────────────────────────────────
test('opts.recoverFrac tightens the band', () => {
  // recoverFrac 0.99 ⇒ must be within 1% of baseline; current 95 (5% off) now lapses.
  const v = classifyRecovery(sym('leads'), { baseline: 100, current: 95 }, { recoverFrac: 0.99 })
  assert.equal(v.outcome, 'lapsed')
  assert.equal(v.reason, 'still_off_baseline')
})

test('opts.recoverFrac loosens the band', () => {
  // recoverFrac 0.8 ⇒ within 20%; current 85 (15% off) now counts as recovered.
  const v = classifyRecovery(sym('leads'), { baseline: 100, current: 85 }, { recoverFrac: 0.8 })
  assert.equal(v.outcome, 'recovered')
  assert.equal(v.reason, 'metric_returned_to_baseline')
})

test('garbage recoverFrac falls back to the 0.9 default', () => {
  const v = classifyRecovery(sym('leads'), { baseline: 100, current: 95 }, { recoverFrac: 'nope' })
  assert.equal(v.outcome, 'recovered') // 5% off ≤ 10% default band
})

// ── unmeasurable / garbage probe → safe lapsed ──────────────────────────────
test('symptom with no probe → lapsed no_recovery_signal', () => {
  const v = classifyRecovery(sym('leads'), null)
  assert.equal(v.outcome, 'lapsed')
  assert.equal(v.reason, 'no_recovery_signal')
})

test('symptom with non-positive or missing baseline → lapsed unmeasurable', () => {
  for (const probe of [{ baseline: 0, current: 5 }, { baseline: -3, current: 5 }, { current: 5 }, { baseline: 'x', current: 5 }]) {
    const v = classifyRecovery(sym('leads'), probe)
    assert.equal(v.outcome, 'lapsed', `probe ${JSON.stringify(probe)} must be unmeasurable`)
    assert.equal(v.reason, 'unmeasurable')
  }
})

test('symptom with missing/garbage current → lapsed unmeasurable', () => {
  for (const probe of [{ baseline: 100 }, { baseline: 100, current: NaN }, { baseline: 100, current: 'x' }]) {
    const v = classifyRecovery(sym('leads'), probe)
    assert.equal(v.outcome, 'lapsed')
    assert.equal(v.reason, 'unmeasurable')
  }
})

// ── kinds we refuse to judge ─────────────────────────────────────────────────
test('non-recoverable kinds → lapsed kind_not_recoverable', () => {
  for (const kind of ['forecast', 'pacing', 'benchmark', 'data_health', 'mystery']) {
    const f = { kind, metric: 'leads', evidence: {} }
    const v = classifyRecovery(f, { baseline: 100, current: 100 })
    assert.equal(v.outcome, 'lapsed', `${kind} must not be judged recovered`)
    assert.equal(v.reason, 'kind_not_recoverable')
    assert.equal(v.kind, kind)
  }
})

test('symptom kind WITHOUT a metric → lapsed kind_not_recoverable', () => {
  const v = classifyRecovery({ kind: 'anomaly', metric: null, evidence: {} }, { baseline: 100, current: 100 })
  assert.equal(v.outcome, 'lapsed')
  assert.equal(v.reason, 'kind_not_recoverable')
})

// ── exact verdict shape ──────────────────────────────────────────────────────
test('verdict carries exactly the documented keys', () => {
  const keys = (o) => Object.keys(o).sort()
  const want = ['baseline', 'current', 'kind', 'metric', 'outcome', 'recovered', 'recoveryPct', 'reason'].sort()
  assert.deepEqual(keys(classifyRecovery(sym('leads'), { baseline: 100, current: 95 })), want)
  assert.deepEqual(keys(classifyRecovery(cov(), { fresh: true })), want)
  assert.deepEqual(keys(classifyRecovery(null, null)), want)
})

// ── purity ───────────────────────────────────────────────────────────────────
test('PURE: neither finding nor probe is mutated', () => {
  const finding = sym('leads')
  const probe = { baseline: 100, current: 95 }
  const fSnap = JSON.stringify(finding)
  const pSnap = JSON.stringify(probe)
  const v = classifyRecovery(finding, probe)
  assert.equal(JSON.stringify(finding), fSnap, 'finding must not be mutated')
  assert.equal(JSON.stringify(probe), pSnap, 'probe must not be mutated')
  // the verdict is a fresh object, not the finding with keys grafted on
  assert.notEqual(v, finding)
  assert.equal('outcome' in finding, false)
})
