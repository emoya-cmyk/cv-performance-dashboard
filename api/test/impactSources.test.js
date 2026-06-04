// ============================================================
// test/impactSources.test.js — the influence-layer ADAPTER, mapping-by-mapping.
//
// lib/impactSources.js is the honest seam between the upstream verdicts (recovered
// findings, vindicated budget shifts, graded early-warnings) and the canonical impact
// event the ledger algebra consumes. These tests pin each mapping rule exactly:
//
//   • a recovered REVENUE anomaly with a real, MOVED baseline→latest pair books the
//     cleared deviation in DOLLARS (|baseline − latest|); every other recovery is one
//     COUNT, and NO recovery asserts a confidence of its own (so the ledger's neutral
//     0.5 applies — a real win, never dressed up as proven);
//   • the reallocation table maps to exactly ONE agency-level COUNT (client_id = null),
//     carrying the calibrated hit_rate, and stays silent when nothing was vindicated;
//   • a graded pulseAccuracy result maps to one COUNT of true-positives at its precision,
//     and ONLY when it's actually graded with a positive count;
//   • collectImpactEvents fans the three sources into one flat raw-event list, dropping
//     every null and tolerating any missing/garbage source.
//
// The capstone tests feed the adapter's output straight through buildImpactLedger to
// prove the honesty property end to end: a recovery-only ledger can NEVER call itself
// "proven" (0.5 < 0.6 gate), while a calibrated count source clearing the bar can.
// Pure: same input → same events; inputs are never mutated. No DB, no clock, no LLM.
// ============================================================

'use strict'

const { test } = require('node:test')
const assert   = require('node:assert/strict')

const {
  recoveryToImpact,
  reallocationToImpact,
  pulseAccuracyToImpact,
  earlyWarningToImpact,
  collectImpactEvents,
  IMPACT_METRICS,
  metricOf,
} = require('../lib/impactSources')

const { buildImpactLedger, CATEGORY, UNIT } = require('../lib/impactLedger')

// ── factories mirroring the real upstream shapes ──────────────────────────────
// a normalized recovery row (insights.normalizeRecoveryRow)
const rec = (over = {}) => ({
  id: 'f1',
  client_id: 'c1',
  client_name: 'Acme',
  metric: 'leads',
  title: 'Leads recovered',
  recovery_reason: 'returned to baseline',
  recovered_at: '2026-05-20T00:00:00.000Z',
  evidence: {},
  ...over,
})
// a serialized portfolio reallocation-efficacy table (only the fields the adapter reads)
const realloc = (over = {}) => ({
  as_of: '2026-05-25',
  scope: 'portfolio',
  overall: { key: '__overall__', n: 9, vindicated: 6, hit_rate: 0.7, ...(over.overall || {}) },
  ...((() => { const o = { ...over }; delete o.overall; return o })()),
})
// a graded pulseAccuracy result (only the fields the adapter reads)
const grade = (over = {}) => ({ status: 'graded', tp: 4, precision: 0.8, ...over })

// =============================================================================
// recoveryToImpact
// =============================================================================

test('recovery: a moved REVENUE baseline→latest books the cleared deviation in DOLLARS', () => {
  const e = recoveryToImpact(rec({ metric: 'revenue', evidence: { baseline: 5000, latest: 3800 } }))
  assert.equal(e.category, CATEGORY.RECOVERY)
  assert.equal(e.unit, UNIT.DOLLARS)
  assert.equal(e.value, 1200)                 // |5000 − 3800|
  assert.equal(e.metric, 'revenue')
  assert.equal(e.client_id, 'c1')
  assert.equal(e.client_name, 'Acme')
  assert.equal(e.occurred_at, '2026-05-20T00:00:00.000Z')
  assert.equal(e.detail, 'returned to baseline')
  assert.ok(!('confidence' in e), 'recovery asserts no confidence of its own')
})

test('recovery: magnitude is absolute — a recovered DROP and a recovered SPIKE book the same', () => {
  const drop = recoveryToImpact(rec({ metric: 'revenue', evidence: { baseline: 5000, latest: 3800 } }))
  const rise = recoveryToImpact(rec({ metric: 'revenue', evidence: { baseline: 3800, latest: 5000 } }))
  assert.equal(drop.value, 1200)
  assert.equal(rise.value, 1200)
})

test('recovery: a non-revenue metric is one COUNT, never a dollar figure', () => {
  const e = recoveryToImpact(rec({ metric: 'leads', evidence: { baseline: 50, latest: 30 } }))
  assert.equal(e.unit, UNIT.COUNT)
  assert.equal(e.value, 1)
  assert.equal(e.metric, 'leads')
})

test('recovery: revenue WITHOUT a usable baseline/latest pair falls back to one COUNT', () => {
  // missing evidence
  assert.equal(recoveryToImpact(rec({ metric: 'revenue', evidence: {} })).unit, UNIT.COUNT)
  // only one side present
  assert.equal(recoveryToImpact(rec({ metric: 'revenue', evidence: { baseline: 5000 } })).unit, UNIT.COUNT)
  // a non-numeric side
  assert.equal(recoveryToImpact(rec({ metric: 'revenue', evidence: { baseline: 'n/a', latest: 10 } })).unit, UNIT.COUNT)
  // equal baseline & latest ⇒ zero deviation ⇒ not a dollar magnitude, just a count
  const flat = recoveryToImpact(rec({ metric: 'revenue', evidence: { baseline: 4000, latest: 4000 } }))
  assert.equal(flat.unit, UNIT.COUNT)
  assert.equal(flat.value, 1)
})

test('recovery: an unrecognized metric rides as an untyped count (metric → null)', () => {
  const e = recoveryToImpact(rec({ metric: 'spend' }))
  assert.equal(e.metric, null)
  assert.equal(e.unit, UNIT.COUNT)
  assert.equal(e.value, 1)
})

test('recovery: detail prefers recovery_reason, then falls back to title', () => {
  assert.equal(recoveryToImpact(rec({ recovery_reason: 'why', title: 'T' })).detail, 'why')
  assert.equal(recoveryToImpact(rec({ recovery_reason: '  ', title: 'T' })).detail, 'T')
  assert.equal(recoveryToImpact(rec({ recovery_reason: null, title: null })).detail, null)
})

test('recovery: a numeric client_id is coerced to a string, never lost', () => {
  const e = recoveryToImpact(rec({ client_id: 12345 }))
  assert.equal(e.client_id, '12345')
  assert.equal(typeof e.client_id, 'string')
})

test('recovery: garbage in → null, never a throw', () => {
  assert.equal(recoveryToImpact(null), null)
  assert.equal(recoveryToImpact(undefined), null)
  assert.equal(recoveryToImpact('nope'), null)
  assert.equal(recoveryToImpact(42), null)
})

test('recovery: a recovered-revenue event survives the ledger as DOLLARS at neutral confidence', () => {
  // the round-trip that matters: adapter omits confidence ⇒ ledger applies 0.5
  const e = recoveryToImpact(rec({ metric: 'revenue', evidence: { baseline: 5000, latest: 3800 } }))
  const led = buildImpactLedger([e])
  assert.equal(led.count, 1)
  assert.equal(led.headline.unit, UNIT.DOLLARS)
  assert.equal(led.headline.value, 1200)
  assert.equal(led.confidence, 0.5)           // neutral default, never inflated
  assert.equal(led.entries[0].weighted_value, 600)   // 1200 × 0.5
})

// =============================================================================
// reallocationToImpact
// =============================================================================

test('reallocation: maps the overall row to ONE agency-level COUNT with the calibrated hit_rate', () => {
  const e = reallocationToImpact(realloc())
  assert.equal(e.category, CATEGORY.REALLOCATION)
  assert.equal(e.unit, UNIT.COUNT)
  assert.equal(e.value, 6)                     // overall.vindicated
  assert.equal(e.confidence, 0.7)              // overall.hit_rate
  assert.equal(e.client_id, null, 'agency-only — never attributed to a client')
  assert.equal(e.client_name, null)
  assert.equal(e.metric, null)
  assert.equal(e.occurred_at, '2026-05-25')
  assert.match(e.detail, /6 budget shifts/)
})

test('reallocation: stays silent when nothing was vindicated', () => {
  assert.equal(reallocationToImpact(realloc({ overall: { vindicated: 0, hit_rate: 0.5 } })), null)
  assert.equal(reallocationToImpact(realloc({ overall: { vindicated: -2, hit_rate: 0.5 } })), null)
})

test('reallocation: no overall row / no table → null', () => {
  assert.equal(reallocationToImpact(null), null)
  assert.equal(reallocationToImpact({}), null)
  assert.equal(reallocationToImpact({ overall: null }), null)
  assert.equal(reallocationToImpact('nope'), null)
})

test('reallocation: a non-finite hit_rate omits confidence (ledger neutral default applies)', () => {
  const e = reallocationToImpact(realloc({ overall: { vindicated: 4, hit_rate: null } }))
  assert.ok(!('confidence' in e) || e.confidence === undefined)
  // and through the ledger it lands at the neutral 0.5
  const led = buildImpactLedger([e])
  assert.equal(led.entries[0].confidence, 0.5)
})

test('reallocation: detail singularizes for a single vindicated shift', () => {
  const e = reallocationToImpact(realloc({ overall: { vindicated: 1, hit_rate: 0.9 } }))
  assert.match(e.detail, /1 budget shift held up/)
})

// =============================================================================
// pulseAccuracyToImpact / earlyWarningToImpact
// =============================================================================

test('early_warning: a graded result maps to one COUNT of true-positives at its precision', () => {
  const e = pulseAccuracyToImpact(grade({ tp: 4, precision: 0.8 }),
    { clientId: 'c2', clientName: 'Globex', metric: 'leads', occurredAt: '2026-05-18' })
  assert.equal(e.category, CATEGORY.EARLY_WARNING)
  assert.equal(e.unit, UNIT.COUNT)
  assert.equal(e.value, 4)                     // tp
  assert.equal(e.confidence, 0.8)              // precision
  assert.equal(e.client_id, 'c2')
  assert.equal(e.client_name, 'Globex')
  assert.equal(e.metric, 'leads')
  assert.equal(e.occurred_at, '2026-05-18')
})

test('early_warning: only a GRADED result with a positive count and finite precision counts', () => {
  const ctx = { clientId: 'c2', metric: 'leads' }
  assert.equal(pulseAccuracyToImpact(grade({ status: 'insufficient' }), ctx), null)
  assert.equal(pulseAccuracyToImpact(grade({ tp: 0 }), ctx), null)
  assert.equal(pulseAccuracyToImpact(grade({ tp: -1 }), ctx), null)
  assert.equal(pulseAccuracyToImpact(grade({ precision: null }), ctx), null)
  assert.equal(pulseAccuracyToImpact(null, ctx), null)
  assert.equal(pulseAccuracyToImpact('nope', ctx), null)
})

test('early_warning: earlyWarningToImpact is the same function under the ledger-category name', () => {
  assert.equal(earlyWarningToImpact, pulseAccuracyToImpact)
})

test('early_warning: a numeric clientId is coerced; an unknown metric rides untyped', () => {
  const e = pulseAccuracyToImpact(grade(), { clientId: 77, metric: 'ctr' })
  assert.equal(e.client_id, '77')
  assert.equal(e.metric, null)                 // 'ctr' is not an impact metric
})

test('early_warning: missing ctx is tolerated (no attribution, still a valid win)', () => {
  const e = pulseAccuracyToImpact(grade())
  assert.equal(e.client_id, null)
  assert.equal(e.client_name, null)
  assert.equal(e.value, 4)
})

// =============================================================================
// collectImpactEvents
// =============================================================================

test('collect: fans all three sources into one flat list, dropping every null', () => {
  const events = collectImpactEvents({
    recoveries: [
      rec({ metric: 'revenue', evidence: { baseline: 5000, latest: 3800 } }),  // DOLLARS
      rec({ metric: 'leads' }),                                                 // COUNT
      null,                                                                     // dropped
      'garbage',                                                                // dropped
    ],
    reallocation: realloc(),                                                    // 1 agency COUNT
    earlyWarnings: [
      { grade: grade({ tp: 3, precision: 0.9 }), clientId: 'c2', metric: 'leads' }, // COUNT
      { grade: grade({ status: 'insufficient' }), clientId: 'c3' },                 // dropped
      null,                                                                          // dropped
    ],
  })
  assert.equal(events.length, 4)               // 2 recovery + 1 reallocation + 1 early-warning
  const cats = events.map(e => e.category).sort()
  assert.deepEqual(cats, [CATEGORY.EARLY_WARNING, CATEGORY.RECOVERY, CATEGORY.RECOVERY, CATEGORY.REALLOCATION].sort())
})

test('collect: every source is optional — missing/garbage sources yield no events', () => {
  assert.deepEqual(collectImpactEvents({}), [])
  assert.deepEqual(collectImpactEvents(), [])
  assert.deepEqual(collectImpactEvents(null), [])
  assert.deepEqual(collectImpactEvents({ recoveries: 'nope', reallocation: 5, earlyWarnings: {} }), [])
})

test('collect: output feeds buildImpactLedger directly', () => {
  const events = collectImpactEvents({
    recoveries: [rec({ metric: 'revenue', evidence: { baseline: 5000, latest: 3800 } })],
    reallocation: realloc(),
    earlyWarnings: [{ grade: grade(), clientId: 'c2', metric: 'leads' }],
  })
  const led = buildImpactLedger(events)
  assert.equal(led.count, 3)
  // dollars carry the headline (most legible / wins ties), recovery + early-warning are counts
  assert.equal(led.headline.unit, UNIT.DOLLARS)
  assert.ok(led.by_unit[UNIT.DOLLARS])
  assert.ok(led.by_unit[UNIT.COUNT])
})

// =============================================================================
// honesty property — end to end through the ledger
// =============================================================================

test('honesty: a recovery-ONLY ledger can never call itself proven (0.5 < 0.6 gate)', () => {
  // four recovered revenue wins — plenty of count, but pinned at neutral confidence
  const recoveries = [
    rec({ id: 'a', metric: 'revenue', evidence: { baseline: 5000, latest: 3000 } }),
    rec({ id: 'b', metric: 'revenue', evidence: { baseline: 4000, latest: 2500 } }),
    rec({ id: 'c', metric: 'revenue', evidence: { baseline: 3000, latest: 2000 } }),
    rec({ id: 'd', metric: 'revenue', evidence: { baseline: 2000, latest: 1000 } }),
  ]
  const led = buildImpactLedger(collectImpactEvents({ recoveries }))
  assert.equal(led.count, 4)
  assert.equal(led.headline.unit, UNIT.DOLLARS)
  assert.equal(led.confidence, 0.5)
  assert.equal(led.proven, false, 'recoveries alone are real wins but never a proven track record')
})

test('honesty: a calibrated count source clearing the bar CAN flip proven true', () => {
  // three graded early-warnings at high precision → count headline, confidence ≥ 0.6
  const earlyWarnings = [
    { grade: grade({ tp: 3, precision: 0.9 }), clientId: 'c1', metric: 'leads' },
    { grade: grade({ tp: 4, precision: 0.85 }), clientId: 'c2', metric: 'jobs' },
    { grade: grade({ tp: 2, precision: 0.8 }), clientId: 'c3', metric: 'revenue' },
  ]
  const led = buildImpactLedger(collectImpactEvents({ earlyWarnings }))
  assert.equal(led.headline.unit, UNIT.COUNT)
  assert.ok(led.confidence >= 0.6)
  assert.equal(led.proven, true)
})

// =============================================================================
// metricOf / IMPACT_METRICS + purity
// =============================================================================

test('metricOf recognizes exactly revenue/leads/jobs, nulls everything else', () => {
  assert.equal(metricOf('revenue'), 'revenue')
  assert.equal(metricOf('leads'), 'leads')
  assert.equal(metricOf('jobs'), 'jobs')
  assert.equal(metricOf(' jobs '), 'jobs')     // trimmed
  assert.equal(metricOf('spend'), null)
  assert.equal(metricOf(''), null)
  assert.equal(metricOf(null), null)
  assert.equal(metricOf(7), null)
  assert.deepEqual([...IMPACT_METRICS].sort(), ['jobs', 'leads', 'revenue'])
})

test('purity: inputs are never mutated and identical input yields identical events', () => {
  const row = rec({ metric: 'revenue', evidence: { baseline: 5000, latest: 3800 } })
  const snapshot = JSON.parse(JSON.stringify(row))
  const a = recoveryToImpact(row)
  const b = recoveryToImpact(row)
  assert.deepEqual(row, snapshot, 'input row untouched')
  assert.deepEqual(a, b, 'deterministic')

  const sources = {
    recoveries: [row],
    reallocation: realloc(),
    earlyWarnings: [{ grade: grade(), clientId: 'c2', metric: 'leads' }],
  }
  const srcSnap = JSON.parse(JSON.stringify(sources))
  const e1 = collectImpactEvents(sources)
  const e2 = collectImpactEvents(sources)
  assert.deepEqual(sources, srcSnap, 'sources untouched')
  assert.deepEqual(e1, e2, 'deterministic collection')
})
