'use strict'

// Tests for lib/efficacy.js — the action→recovery learning loop. Pins the classify
// mapping (MEASURED recovery only, never human resolution), the play key, the tally,
// the Beta-Bernoulli shrinkage + Wilson lower-bound math against hand arithmetic, the
// median (incl. the even-length convention), the ranked-table pipeline, efficacyNote
// gating on earned sample size, and the no-evidence no-op. Same node:test house style
// as precision.test.js / outcomes.test.js.

const { test } = require('node:test')
const assert   = require('node:assert/strict')

const {
  classifyEfficacy, playKey, tallyEfficacy, rateOf,
  efficacyOf, wilsonLower, medianOf, bandOf, baseRateOf,
  efficacyTable, efficacyNote,
  PRIOR_WEIGHT, PRIOR_MEAN, EFF_LOW, EFF_HIGH, NOTE_MIN_N,
} = require('../lib/efficacy')

const approx = (a, b, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b} (±${eps})`)

// ── classifyEfficacy: the line between a SAMPLE and a non-sample ──────────────
test('classifyEfficacy: recovered (any shape) → success', () => {
  assert.equal(classifyEfficacy({ recovered: true }), 'success')
  assert.equal(classifyEfficacy({ outcome: 'recovered' }), 'success')
  assert.equal(classifyEfficacy({ status: 'recovered' }), 'success')
  assert.equal(classifyEfficacy({ outcome: 'RECOVERED' }), 'success')   // case-insensitive
})

test('classifyEfficacy: lapsed / expired → failure', () => {
  assert.equal(classifyEfficacy({ outcome: 'lapsed' }), 'failure')
  assert.equal(classifyEfficacy({ status: 'lapsed' }), 'failure')
  assert.equal(classifyEfficacy({ status: 'expired' }), 'failure')
})

test('classifyEfficacy: human resolution / open / junk → pending (NOT a sample)', () => {
  // acknowledged + resolved are ENGAGEMENT (precision.js), not measured recovery
  assert.equal(classifyEfficacy({ status: 'acknowledged' }), 'pending')
  assert.equal(classifyEfficacy({ status: 'resolved' }), 'pending')
  assert.equal(classifyEfficacy({ status: 'active' }), 'pending')
  assert.equal(classifyEfficacy({}), 'pending')
  assert.equal(classifyEfficacy(null), 'pending')
  assert.equal(classifyEfficacy({ recovered: false }), 'pending')       // false ≠ failure; absence of proof
})

test('classifyEfficacy: recovered:true wins over a stale status', () => {
  assert.equal(classifyEfficacy({ recovered: true, status: 'active' }), 'success')
})

// ── playKey ───────────────────────────────────────────────────────────────────
test('playKey: kind::metric, with a wildcard for metric-less kinds', () => {
  assert.equal(playKey({ kind: 'trend', metric: 'leads' }), 'trend::leads')
  assert.equal(playKey({ kind: 'coverage_gap' }), 'coverage_gap::*')
  assert.equal(playKey({}), 'unknown::*')
  assert.equal(playKey(null), 'unknown::*')
})

// ── tallyEfficacy ──────────────────────────────────────────────────────────────
test('tallyEfficacy: groups by play, counts decided only, collects success days', () => {
  const rows = [
    { kind: 'trend', metric: 'leads', recovered: true,  days_to_recovery: 10 },
    { kind: 'trend', metric: 'leads', outcome: 'lapsed' },
    { kind: 'trend', metric: 'leads', recovered: true,  days_to_recovery: 4 },
    { kind: 'trend', metric: 'leads', status: 'acknowledged' },   // pending — ignored
    { kind: 'anomaly', metric: 'spend', outcome: 'recovered', days_to_recovery: 2 },
  ]
  const t = tallyEfficacy(rows)
  const leads = t.get('trend::leads')
  assert.equal(leads.successes, 2)
  assert.equal(leads.failures, 1)
  assert.equal(leads.n, 3)                       // pending row excluded from n
  assert.deepEqual(leads.days.slice().sort((a, b) => a - b), [4, 10])
  const spend = t.get('anomaly::spend')
  assert.equal(spend.successes, 1)
  assert.equal(spend.n, 1)
  assert.deepEqual(spend.days, [2])
})

test('tallyEfficacy: non-array / empty → empty map; junk days dropped from median pool', () => {
  assert.equal(tallyEfficacy(null).size, 0)
  assert.equal(tallyEfficacy([]).size, 0)
  const t = tallyEfficacy([
    { kind: 'trend', metric: 'leads', recovered: true, days_to_recovery: -3 },   // negative → dropped
    { kind: 'trend', metric: 'leads', recovered: true, days_to_recovery: 'x' },  // NaN → dropped
    { kind: 'trend', metric: 'leads', recovered: true },                          // missing → dropped
  ])
  const leads = t.get('trend::leads')
  assert.equal(leads.successes, 3)
  assert.deepEqual(leads.days, [])               // none of the three contributed a finite day
})

test('tallyEfficacy: accepts camelCase daysToRecovery too', () => {
  const t = tallyEfficacy([{ kind: 'trend', metric: 'leads', recovered: true, daysToRecovery: 7 }])
  assert.deepEqual(t.get('trend::leads').days, [7])
})

// ── rateOf ─────────────────────────────────────────────────────────────────────
test('rateOf: raw success share, null when no decided samples', () => {
  approx(rateOf({ successes: 3, failures: 1 }), 0.75)
  assert.equal(rateOf({ successes: 0, failures: 0 }), null)
  assert.equal(rateOf({}), null)
})

// ── efficacyOf: Beta-Bernoulli shrinkage ───────────────────────────────────────
test('efficacyOf: neutral prior at n=0 → priorMean', () => {
  approx(efficacyOf({ successes: 0, failures: 0 }), PRIOR_MEAN)           // 0.5 default
  approx(efficacyOf({ successes: 0, failures: 0 }, { priorMean: 0.3 }), 0.3)
})

test('efficacyOf: matches hand arithmetic (successes + pm·k)/(n + k)', () => {
  // 3 successes, 1 failure, prior 0.5, weight 6 → (3 + 0.5·6)/(4 + 6) = 6/10 = 0.6
  approx(efficacyOf({ successes: 3, failures: 1 }, { priorMean: 0.5, priorWeight: 6 }), 0.6)
  // 8 successes, 2 failures, prior 0.4, weight 6 → (8 + 2.4)/(10 + 6) = 10.4/16 = 0.65
  approx(efficacyOf({ successes: 8, failures: 2 }, { priorMean: 0.4, priorWeight: 6 }), 0.65)
})

test('efficacyOf: shrinks toward prior at low n, toward raw rate at high n', () => {
  const lo = efficacyOf({ successes: 1, failures: 0 }, { priorMean: 0.5, priorWeight: 6 }) // (1+3)/(1+6)=0.571
  approx(lo, round3(4 / 7))
  const hi = efficacyOf({ successes: 100, failures: 0 }, { priorMean: 0.5, priorWeight: 6 }) // →~0.943
  assert.ok(hi > 0.93 && hi < 1)
})

test('efficacyOf: junk / clamped inputs never throw, stay in [0,1]', () => {
  approx(efficacyOf({ successes: 'x', failures: null }), PRIOR_MEAN)      // junk counts → 0,0 → prior
  const v = efficacyOf({ successes: 5, failures: 5 }, { priorMean: 9, priorWeight: -3 })
  assert.ok(v >= 0 && v <= 1)                                            // priorMean clamped, weight floored to 0
})

// ── wilsonLower: the ranking key ────────────────────────────────────────────────
test('wilsonLower: n=0 → 0 (no evidence, no credit)', () => {
  assert.equal(wilsonLower({ successes: 0, failures: 0 }), 0)
  assert.equal(wilsonLower({}), 0)
})

test('wilsonLower: deeper evidence outranks a lucky single sample', () => {
  const oneForOne = wilsonLower({ successes: 1, failures: 0 })           // p̂=1 but wide interval
  const nineForTen = wilsonLower({ successes: 9, failures: 1 })          // p̂=0.9 but tight
  assert.ok(nineForTen > oneForOne, `9/10 (${nineForTen}) should rank above 1/1 (${oneForOne})`)
})

test('wilsonLower: matches the closed form for 8/10', () => {
  // p=0.8, n=10, z=1.96, z²=3.8416 → center=0.8+3.8416/20=0.99208; denom=1+0.38416=1.38416
  // margin=1.96·sqrt((0.16+0.09604)/10)=1.96·sqrt(0.025604)=1.96·0.1600125=0.3136245
  // lower=(0.99208-0.3136245)/1.38416=0.6784555/1.38416=0.490157 → 0.490
  approx(wilsonLower({ successes: 8, failures: 2 }), 0.49, 5e-4)
})

// ── medianOf ────────────────────────────────────────────────────────────────────
test('medianOf: empty → null; odd → middle; even → mean of two middles', () => {
  assert.equal(medianOf([]), null)
  assert.equal(medianOf(null), null)
  assert.equal(medianOf([5]), 5)
  assert.equal(medianOf([3, 1, 2]), 2)                                   // sorts first
  assert.equal(medianOf([1, 2, 3, 4]), 2.5)                             // (2+3)/2
  assert.equal(medianOf([10, 2, 8, 4]), 6)                              // sorted 2,4,8,10 → (4+8)/2
})

test('medianOf: drops non-finite entries before computing', () => {
  assert.equal(medianOf([2, NaN, 4, Infinity]), 3)                      // finite {2,4} → 3
})

// ── bandOf ────────────────────────────────────────────────────────────────────
test('bandOf: low / medium / high around the thresholds', () => {
  assert.equal(bandOf(EFF_LOW - 0.01), 'low')
  assert.equal(bandOf(EFF_LOW), 'medium')
  assert.equal(bandOf(EFF_HIGH - 0.01), 'medium')
  assert.equal(bandOf(EFF_HIGH), 'high')
  assert.equal(bandOf('x'), 'medium')                                    // junk → medium
})

// ── baseRateOf: the pooled, data-driven prior ───────────────────────────────────
test('baseRateOf: pools decided rows; null mean until there is evidence', () => {
  assert.deepEqual(baseRateOf([]), { mean: null, n: 0 })
  assert.deepEqual(baseRateOf([{ status: 'acknowledged' }]), { mean: null, n: 0 })   // pending only
  const b = baseRateOf([
    { recovered: true }, { recovered: true }, { outcome: 'lapsed' }, { status: 'resolved' },
  ])
  assert.equal(b.n, 3)                                                   // resolved is pending → excluded
  approx(b.mean, 2 / 3)
})

// ── efficacyTable: the one-call pipeline + ranking ──────────────────────────────
test('efficacyTable: builds per-play records, ranks by Wilson lower bound', () => {
  const rows = [
    // deep, strong play
    ...Array.from({ length: 9 }, () => ({ kind: 'trend', metric: 'leads', recovered: true, days_to_recovery: 6 })),
    { kind: 'trend', metric: 'leads', outcome: 'lapsed' },               // leads: 9/10
    // shallow, perfect play (should NOT outrank leads despite 100%)
    { kind: 'anomaly', metric: 'spend', recovered: true, days_to_recovery: 3 }, // spend: 1/1
    // weak play
    { kind: 'forecast', metric: 'revenue', outcome: 'lapsed' },
    { kind: 'forecast', metric: 'revenue', outcome: 'lapsed' },          // revenue: 0/2
  ]
  const { table, ranked, base } = efficacyTable(rows)

  const leads = table.get('trend::leads')
  assert.equal(leads.successes, 9)
  assert.equal(leads.n, 10)
  approx(leads.recovery_rate, 0.9)
  assert.equal(leads.median_days, 6)
  assert.equal(leads.band, 'high')

  // ranking: 9/10 (deep) ahead of 1/1 (shallow) ahead of 0/2 (weak)
  assert.deepEqual(ranked.map(r => r.play), ['trend::leads', 'anomaly::spend', 'forecast::revenue'])
  assert.deepEqual(ranked.map(r => r.rank), [1, 2, 3])
  // rank mirrored back into the Map records
  assert.equal(table.get('trend::leads').rank, 1)
  assert.equal(table.get('forecast::revenue').rank, 3)

  // global base rate = 10 successes / 13 decided
  assert.equal(base.n, 13)
  approx(base.rate, round3(10 / 13))
})

test('efficacyTable: weak play with successes still shrinks toward base, not raw 0', () => {
  const { table } = efficacyTable([
    // a strong play makes the pooled base rate > 0 (here 0.5)...
    { kind: 'trend', metric: 'leads', recovered: true },
    { kind: 'trend', metric: 'leads', recovered: true },
    // ...so this all-failure play shrinks toward that positive base, not a hard 0
    { kind: 'forecast', metric: 'revenue', outcome: 'lapsed' },
    { kind: 'forecast', metric: 'revenue', outcome: 'lapsed' },
  ])
  const rev = table.get('forecast::revenue')
  assert.equal(rev.recovery_rate, 0)                                     // raw is 0/2
  assert.ok(rev.efficacy > 0)                                            // (0 + 0.5·6)/(2+6)=0.375 — not a hard 0
  assert.equal(rev.lower, 0)                                             // Wilson lower bound IS 0 (0 successes)
})

test('efficacyTable: explicit priorMean overrides the pooled base rate', () => {
  const rows = [{ kind: 'trend', metric: 'leads', recovered: true }, { kind: 'trend', metric: 'leads', outcome: 'lapsed' }]
  const strict = efficacyTable(rows, { priorMean: 0 }).table.get('trend::leads')
  // (1 + 0·6)/(2 + 6) = 1/8 = 0.125
  approx(strict.efficacy, 0.125)
})

test('efficacyTable: no rows → empty table, neutral base', () => {
  const { table, ranked, base } = efficacyTable([])
  assert.equal(table.size, 0)
  assert.deepEqual(ranked, [])
  assert.deepEqual(base, { rate: null, n: 0, prior: round3(PRIOR_MEAN) })
})

// ── efficacyNote: only boasts once earned ───────────────────────────────────────
test('efficacyNote: silent below NOTE_MIN_N, speaks at/above it', () => {
  const rowsThin = Array.from({ length: NOTE_MIN_N - 1 }, () => ({ kind: 'trend', metric: 'leads', recovered: true }))
  const thin = efficacyTable(rowsThin)
  assert.equal(efficacyNote('trend::leads', thin.table), null)          // not enough evidence yet

  const rowsEnough = [
    ...Array.from({ length: 4 }, () => ({ kind: 'trend', metric: 'leads', recovered: true, days_to_recovery: 5 })),
    { kind: 'trend', metric: 'leads', outcome: 'lapsed' },
  ]
  const full = efficacyTable(rowsEnough)
  const note = efficacyNote({ kind: 'trend', metric: 'leads' }, full.table)   // accepts a finding too
  assert.ok(note && typeof note.text === 'string')
  assert.equal(note.successes, 4)
  assert.equal(note.n, 5)
  assert.equal(note.median_days, 5)
  assert.match(note.text, /cleared the problem/)
  assert.match(note.text, /4 of 5/)
  assert.match(note.text, /within 5 days/)
})

test('efficacyNote: unknown play or absent table → null', () => {
  const { table } = efficacyTable([{ kind: 'trend', metric: 'leads', recovered: true }])
  assert.equal(efficacyNote('anomaly::spend', table), null)             // play not in table
  assert.equal(efficacyNote('trend::leads', null), null)               // no table
})

test('efficacyNote: accepts the whole table object, not just the Map', () => {
  const built = efficacyTable([
    ...Array.from({ length: 5 }, () => ({ kind: 'trend', metric: 'leads', recovered: true, days_to_recovery: 1 })),
  ])
  const note = efficacyNote('trend::leads', built)                      // pass { table, ranked, base }
  assert.ok(note && note.n === 5)
  assert.match(note.text, /within a day/)                               // singular-day phrasing
})

// round3 mirror for the hand-arithmetic assertions above
function round3(x) { return Math.round(Number(x) * 1000) / 1000 }
