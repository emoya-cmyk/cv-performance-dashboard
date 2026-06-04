'use strict'

// intel-v13 C4 (step a) — contract + invariant locks for the PURE data-version
// core that gates live auto-re-narration. Everything here is deterministic and
// DB-free: it proves the token is stable, order-independent, sensitive to every
// way a scope's data can move (more rows, a later date, an in-place value
// correction, a cross-metric redistribution that leaves totals flat), fail-safe
// on garbage, leak-safe (no tenant identity in the token), and that the
// shouldRefresh gate has exactly the baseline/steady/changed semantics the FE
// relies on.

const { test } = require('node:test')
const assert = require('node:assert')

const {
  VERSION_PREFIX,
  EMPTY_TOKEN,
  toCents,
  normDate,
  normPartial,
  aggregateRows,
  versionFromAggregate,
  computeScopeVersion,
  shouldRefresh,
  isValidToken,
} = require('../lib/scopeFreshness')

// A small canonical fact-row set: two metrics, two channels, three days.
const ROWS = [
  { date: '2026-06-01', metric_key: 'revenue', metric_value: 1000 },
  { date: '2026-06-02', metric_key: 'revenue', metric_value: 1500 },
  { date: '2026-06-02', metric_key: 'leads', metric_value: 12 },
  { date: '2026-06-03', metric_key: 'leads', metric_value: 9 },
]

// ──────────────────────────────────────────────────────────────────────────
// constants + token grammar
// ──────────────────────────────────────────────────────────────────────────

test('VERSION_PREFIX / EMPTY_TOKEN are the declared grammar', () => {
  assert.strictEqual(VERSION_PREFIX, 'sf1')
  assert.strictEqual(EMPTY_TOKEN, 'sf1:empty')
})

test('a populated token has shape sf1:<rows>:<YYYY-MM-DD>:<fp>', () => {
  const tok = computeScopeVersion(ROWS)
  const parts = tok.split(':')
  assert.strictEqual(parts.length, 4)
  assert.strictEqual(parts[0], 'sf1')
  assert.strictEqual(parts[1], '4') // four rows
  assert.match(parts[2], /^\d{4}-\d{2}-\d{2}$/)
  assert.strictEqual(parts[2], '2026-06-03') // latest date
  assert.ok(parts[3].length > 0)
})

// ──────────────────────────────────────────────────────────────────────────
// helpers: toCents / normDate / normPartial
// ──────────────────────────────────────────────────────────────────────────

test('toCents quantises to hundredths and fails safe', () => {
  assert.strictEqual(toCents(10), 1000)
  assert.strictEqual(toCents(10.01), 1001)
  assert.strictEqual(toCents(10.005), 1001) // rounds half up
  assert.strictEqual(toCents(10.004), 1000) // sub-cent jitter is swallowed
  assert.strictEqual(toCents(-3.5), -350)
  assert.strictEqual(toCents('42.50'), 4250)
  assert.strictEqual(toCents(NaN), 0)
  assert.strictEqual(toCents(Infinity), 0)
  assert.strictEqual(toCents(undefined), 0)
  assert.strictEqual(toCents('not a number'), 0)
})

test('normDate keeps a bare calendar day, rejects junk', () => {
  assert.strictEqual(normDate('2026-06-03'), '2026-06-03')
  assert.strictEqual(normDate('2026-06-03T17:42:00Z'), '2026-06-03') // ISO timestamp → day
  assert.strictEqual(normDate('2026-06-03 17:42:00'), '2026-06-03')
  assert.strictEqual(normDate('garbage'), '')
  assert.strictEqual(normDate(''), '')
  assert.strictEqual(normDate(null), '')
  assert.strictEqual(normDate(undefined), '')
})

test('normPartial accepts aliases and clamps; garbage → zeros', () => {
  assert.deepStrictEqual(
    normPartial({ metric_key: 'revenue', count: 3, max_date: '2026-06-03T00:00:00Z', sum_value: 12.34 }),
    { key: 'revenue', rows: 3, maxDate: '2026-06-03', cents: 1234 },
  )
  // pre-quantised cents are taken verbatim (not re-multiplied)
  assert.deepStrictEqual(
    normPartial({ key: 'leads', rows: 2, maxDate: '2026-06-02', cents: 21 }),
    { key: 'leads', rows: 2, maxDate: '2026-06-02', cents: 21 },
  )
  // negative / non-numeric rows clamp to 0; missing fields default
  assert.deepStrictEqual(
    normPartial({ rows: -5 }),
    { key: '', rows: 0, maxDate: '', cents: 0 },
  )
  for (const junk of [null, undefined, 42, 'x', []]) {
    assert.deepStrictEqual(normPartial(junk), { key: '', rows: 0, maxDate: '', cents: 0 })
  }
})

// ──────────────────────────────────────────────────────────────────────────
// aggregateRows
// ──────────────────────────────────────────────────────────────────────────

test('aggregateRows groups by metric_key with summed cents + latest date + count', () => {
  const parts = aggregateRows(ROWS)
  const byKey = Object.fromEntries(parts.map((p) => [p.key, p]))
  assert.deepStrictEqual(byKey.revenue, { key: 'revenue', rows: 2, maxDate: '2026-06-02', cents: 250000 })
  assert.deepStrictEqual(byKey.leads, { key: 'leads', rows: 2, maxDate: '2026-06-03', cents: 2100 })
})

test('aggregateRows: non-array → [], skips non-object rows', () => {
  assert.deepStrictEqual(aggregateRows(null), [])
  assert.deepStrictEqual(aggregateRows('nope'), [])
  assert.deepStrictEqual(aggregateRows(undefined), [])
  const parts = aggregateRows([null, 5, { metric_key: 'revenue', metric_value: 1, date: '2026-06-01' }, 'x'])
  assert.strictEqual(parts.length, 1)
  assert.strictEqual(parts[0].key, 'revenue')
  assert.strictEqual(parts[0].rows, 1)
})

// ──────────────────────────────────────────────────────────────────────────
// versionFromAggregate / computeScopeVersion — determinism + order independence
// ──────────────────────────────────────────────────────────────────────────

test('same data → identical token (deterministic, no clock/random)', () => {
  assert.strictEqual(computeScopeVersion(ROWS), computeScopeVersion(ROWS.slice()))
})

test('row order does not affect the token (commutative fold)', () => {
  const shuffled = [ROWS[3], ROWS[1], ROWS[0], ROWS[2]]
  assert.strictEqual(computeScopeVersion(ROWS), computeScopeVersion(shuffled))
})

test('partial order does not affect the token', () => {
  const parts = aggregateRows(ROWS)
  assert.strictEqual(versionFromAggregate(parts), versionFromAggregate(parts.slice().reverse()))
})

test('single combined aggregate and array-of-one agree', () => {
  const agg = { key: 'revenue', rows: 2, maxDate: '2026-06-02', sumValue: 2500 }
  assert.strictEqual(versionFromAggregate(agg), versionFromAggregate([agg]))
})

// ──────────────────────────────────────────────────────────────────────────
// sensitivity — every way the data can move must move the token
// ──────────────────────────────────────────────────────────────────────────

test('adding a row changes the token', () => {
  const more = ROWS.concat([{ date: '2026-06-03', metric_key: 'revenue', metric_value: 200 }])
  assert.notStrictEqual(computeScopeVersion(more), computeScopeVersion(ROWS))
})

test('an in-place value correction (≥ $0.01) changes the token', () => {
  const corrected = ROWS.map((r, i) => (i === 0 ? { ...r, metric_value: 1000.01 } : r))
  assert.notStrictEqual(computeScopeVersion(corrected), computeScopeVersion(ROWS))
})

test('a later max date changes the token', () => {
  const advanced = ROWS.map((r, i) => (i === 3 ? { ...r, date: '2026-06-04' } : r))
  assert.notStrictEqual(computeScopeVersion(advanced), computeScopeVersion(ROWS))
})

test('redistributing value across metrics (totals flat) STILL changes the token', () => {
  // Move $5.00 from revenue→leads: combined SUM(value) and total rows are
  // unchanged, but the per-key fingerprint must still move. This is exactly why
  // step b groups by metric_key rather than sending one combined aggregate.
  const a = [
    { key: 'revenue', rows: 1, maxDate: '2026-06-02', sumValue: 100 },
    { key: 'leads', rows: 1, maxDate: '2026-06-02', sumValue: 50 },
  ]
  const b = [
    { key: 'revenue', rows: 1, maxDate: '2026-06-02', sumValue: 95 },
    { key: 'leads', rows: 1, maxDate: '2026-06-02', sumValue: 55 },
  ]
  assert.notStrictEqual(versionFromAggregate(a), versionFromAggregate(b))
})

test('a sub-cent value jitter does NOT change the token (float-noise immune)', () => {
  const jittered = ROWS.map((r, i) => (i === 0 ? { ...r, metric_value: 1000.004 } : r))
  assert.strictEqual(computeScopeVersion(jittered), computeScopeVersion(ROWS))
})

// ──────────────────────────────────────────────────────────────────────────
// empty + fail-safe
// ──────────────────────────────────────────────────────────────────────────

test('zero-row scope → EMPTY token (every empty-ish input agrees)', () => {
  assert.strictEqual(computeScopeVersion([]), EMPTY_TOKEN)
  assert.strictEqual(versionFromAggregate([]), EMPTY_TOKEN)
  assert.strictEqual(versionFromAggregate({ key: 'revenue', rows: 0, maxDate: '', sumValue: 0 }), EMPTY_TOKEN)
})

test('garbage input never throws — folds to EMPTY', () => {
  for (const junk of [null, undefined, 'x', 42, {}, [null], [undefined, 'nope', 7]]) {
    assert.strictEqual(versionFromAggregate(junk), EMPTY_TOKEN)
  }
  assert.strictEqual(computeScopeVersion(null), EMPTY_TOKEN)
  assert.strictEqual(computeScopeVersion('nonsense'), EMPTY_TOKEN)
})

test('leak-safety: the token embeds no tenant identity — same aggregate, different client → same token', () => {
  // The module only ever sees aggregates; tenancy is applied upstream (step b
  // scopes the SQL). Two different tenants whose scoped aggregate happens to be
  // identical produce the same opaque token — there is nothing client-specific to
  // leak. (The FE only ever compares tokens within one fixed scope.)
  const tenantA = [{ key: 'revenue', rows: 2, maxDate: '2026-06-02', sumValue: 2500 }]
  const tenantB = [{ key: 'revenue', rows: 2, maxDate: '2026-06-02', sumValue: 2500 }]
  assert.strictEqual(versionFromAggregate(tenantA), versionFromAggregate(tenantB))
  // and nothing in the token spells a client id / name
  assert.ok(!/client|tenant|uuid/i.test(versionFromAggregate(tenantA)))
})

// ──────────────────────────────────────────────────────────────────────────
// isValidToken
// ──────────────────────────────────────────────────────────────────────────

test('isValidToken accepts this module’s tokens (incl. EMPTY), rejects others', () => {
  assert.strictEqual(isValidToken(computeScopeVersion(ROWS)), true)
  assert.strictEqual(isValidToken(EMPTY_TOKEN), true)
  for (const bad of [null, undefined, '', 'sf1', 'sf1:', 'nope', 42, {}, 'sf0:1:2026-06-03:abc']) {
    assert.strictEqual(isValidToken(bad), false)
  }
})

// ──────────────────────────────────────────────────────────────────────────
// shouldRefresh — the FE gate truth table
// ──────────────────────────────────────────────────────────────────────────

test('shouldRefresh: invalid next → false (no usable reading)', () => {
  const valid = computeScopeVersion(ROWS)
  assert.strictEqual(shouldRefresh(valid, null), false)
  assert.strictEqual(shouldRefresh(valid, undefined), false)
  assert.strictEqual(shouldRefresh(valid, 'garbage'), false)
})

test('shouldRefresh: first probe (invalid/null prev) → false (adopt baseline, no spurious refetch)', () => {
  const valid = computeScopeVersion(ROWS)
  assert.strictEqual(shouldRefresh(null, valid), false)
  assert.strictEqual(shouldRefresh(undefined, valid), false)
  assert.strictEqual(shouldRefresh('garbage', valid), false)
})

test('shouldRefresh: equal tokens → false (steady), incl. EMPTY≡EMPTY', () => {
  const valid = computeScopeVersion(ROWS)
  assert.strictEqual(shouldRefresh(valid, valid), false)
  assert.strictEqual(shouldRefresh(EMPTY_TOKEN, EMPTY_TOKEN), false)
})

test('shouldRefresh: two distinct valid tokens → true (changed)', () => {
  const before = computeScopeVersion(ROWS)
  const after = computeScopeVersion(ROWS.concat([{ date: '2026-06-04', metric_key: 'leads', metric_value: 3 }]))
  assert.strictEqual(shouldRefresh(before, after), true)
})

test('shouldRefresh: EMPTY→populated and populated→EMPTY both → true', () => {
  const populated = computeScopeVersion(ROWS)
  assert.strictEqual(shouldRefresh(EMPTY_TOKEN, populated), true) // data appeared
  assert.strictEqual(shouldRefresh(populated, EMPTY_TOKEN), true) // data reset/vanished
})
