'use strict'
// test/scopeNowcastCorroboration.test.js — intel-v14 D7 (step a).
// Proves corroborateNowcast cross-checks the projection's trajectory against the genuinely
// INDEPENDENT delta lens (and only that lens — the trend is the projection's own basis and is
// excluded by construction), returning an honest aligned/mixed verdict, byte-stable & leak-safe.
const { test } = require('node:test')
const assert = require('node:assert/strict')

const { corroborateNowcast } = require('../lib/scopeNowcastCorroboration')
const { METRICS } = require('../lib/ask')

// ── fixtures ─────────────────────────────────────────────────────────────────
// A projected nowcast whose LEAD metric (projections[0]) is revenue, trending up.
const NOWCAST_UP = {
  status: 'projected',
  projections: [
    { metric: 'revenue', metric_label: 'Revenue', direction: 'up', improving: true, projected: 13000, horizon: 1 },
    { metric: 'leads', metric_label: 'Leads', direction: 'up', improving: true, projected: 42, horizon: 1 },
  ],
  headline: 'At this pace, revenue reaches ~$13,000 next update.',
}
// Same lead metric, but the projection points DOWN (e.g. revenue sliding).
const NOWCAST_DOWN = {
  status: 'projected',
  projections: [{ metric: 'revenue', metric_label: 'Revenue', direction: 'down', improving: false, projected: 9000, horizon: 1 }],
  headline: 'At this pace, revenue slips to ~$9,000 next update.',
}

// Delta lenses (diffScopeInsights shape): changes[] carries {metric, direction, …} for moved metrics.
const DELTA_REV_UP = { status: 'changed', changes: [{ metric: 'revenue', metric_label: 'Revenue', delta: 400, direction: 'up', improved: true }] }
const DELTA_REV_DOWN = { status: 'changed', changes: [{ metric: 'revenue', metric_label: 'Revenue', delta: -400, direction: 'down', improved: false }] }
const DELTA_OTHER = { status: 'changed', changes: [{ metric: 'cpl', metric_label: 'Cost per Lead', delta: 5, direction: 'up', improved: false }] }
const DELTA_BASELINE = { status: 'baseline', changes: [] }

// Tokens that must NEVER appear in a corroboration payload (it embeds no tenant identity).
const LEAK_TOKENS = ['client_id', 'clientId', 'scopeClientId', 'tenant', 'locationId', 'location_id', 'accountId', '"7"']

// ── 1. aligned — the independent delta move agrees with the up trajectory ──────
test('D7: aligned when the independent delta lens points the same way as the projection', () => {
  const c = corroborateNowcast(NOWCAST_UP, DELTA_REV_UP)
  assert.equal(c.status, 'corroborated')
  assert.equal(c.reason, null)
  assert.equal(c.level, 'aligned')
  assert.equal(c.leadMetric, 'revenue')
  assert.equal(c.leadLabel, 'Revenue')
  assert.equal(c.trajectory, 'up')
  assert.equal(c.recent, 'up')
  assert.equal(c.agree, true)
  assert.equal(c.witnessCount, 1)
  assert.equal(c.confirmCount, 1)
  assert.equal(c.conflictCount, 0)
  assert.deepEqual(c.witnesses, [{ lens: 'delta', direction: 'up', agrees: true }])
  assert.match(c.note, /also points up/)
  assert.match(c.note, /corroborated/)
  assert.deepEqual(c.meta, { independentLenses: ['delta'], basis: 'cross-lens' })
})

// ── 2. mixed — the independent delta move runs AGAINST the up trajectory ───────
// This is the regime-change catch the self-backtest (D4–D6) structurally cannot provide: the recent
// run is up (so trend up → nowcast up), yet the move since the caller last looked is DOWN.
test('D7: mixed when the independent delta lens points against the projection', () => {
  const c = corroborateNowcast(NOWCAST_UP, DELTA_REV_DOWN)
  assert.equal(c.status, 'corroborated')
  assert.equal(c.level, 'mixed')
  assert.equal(c.trajectory, 'up')
  assert.equal(c.recent, 'down')
  assert.equal(c.agree, false)
  assert.equal(c.witnessCount, 1)
  assert.equal(c.confirmCount, 0)
  assert.equal(c.conflictCount, 1)
  assert.deepEqual(c.witnesses, [{ lens: 'delta', direction: 'down', agrees: false }])
  assert.match(c.note, /points down/)
  assert.match(c.note, /against the projected up/)
  assert.match(c.note, /caution/)
})

// ── 3. no independent lens (no delta) — nothing honest to corroborate against ──
test('D7: status none with reason no-independent-lens when delta is absent', () => {
  const c = corroborateNowcast(NOWCAST_UP, null)
  assert.equal(c.status, 'none')
  assert.equal(c.reason, 'no-independent-lens')
  assert.equal(c.level, 'unconfirmed')
  assert.equal(c.agree, false)
  assert.equal(c.witnessCount, 0)
  assert.deepEqual(c.witnesses, [])
})

// ── 4. delta present but for a DIFFERENT metric — no witness for the lead ──────
test('D7: status none when the delta lens has no entry for the lead metric', () => {
  const c = corroborateNowcast(NOWCAST_UP, DELTA_OTHER)
  assert.equal(c.status, 'none')
  assert.equal(c.reason, 'no-independent-lens')
})

// ── 5. baseline delta (first look — empty changes) — no witness ────────────────
test('D7: status none for a baseline delta with no changes', () => {
  const c = corroborateNowcast(NOWCAST_UP, DELTA_BASELINE)
  assert.equal(c.status, 'none')
  assert.equal(c.reason, 'no-independent-lens')
})

// ── 6. no projected nowcast — nothing to corroborate ──────────────────────────
test('D7: status none with reason no-nowcast when there is no projection', () => {
  assert.equal(corroborateNowcast({ status: 'none' }, DELTA_REV_UP).reason, 'no-nowcast')
  assert.equal(corroborateNowcast({ status: 'insufficient' }, DELTA_REV_UP).reason, 'no-nowcast')
})

// ── 7. malformed lead — projected but no usable lead direction ────────────────
test('D7: status none with reason no-lead for an empty or directionless projection', () => {
  assert.equal(corroborateNowcast({ status: 'projected', projections: [] }, DELTA_REV_UP).reason, 'no-lead')
  assert.equal(
    corroborateNowcast({ status: 'projected', projections: [{ metric: 'revenue', direction: 'sideways' }] }, DELTA_REV_UP).reason,
    'no-lead',
  )
})

// ── 8. down-trajectory aligned — agreement is on raw direction, either way ─────
test('D7: aligned for a down trajectory when the independent move is also down', () => {
  const c = corroborateNowcast(NOWCAST_DOWN, DELTA_REV_DOWN)
  assert.equal(c.status, 'corroborated')
  assert.equal(c.level, 'aligned')
  assert.equal(c.trajectory, 'down')
  assert.equal(c.recent, 'down')
  assert.equal(c.agree, true)
  assert.match(c.note, /also points down/)
})

// ── 9. leak-safety — the payload embeds no tenant identity ─────────────────────
test('D7: corroboration payload carries no tenant identifiers', () => {
  for (const c of [corroborateNowcast(NOWCAST_UP, DELTA_REV_UP), corroborateNowcast(NOWCAST_UP, DELTA_REV_DOWN)]) {
    const json = JSON.stringify(c)
    for (const tok of LEAK_TOKENS) assert.ok(!json.includes(tok), `must not leak ${tok}`)
  }
})

// ── 10. purity / determinism — same inputs, byte-identical output ──────────────
test('D7: deterministic — identical inputs yield deep-equal results', () => {
  assert.deepEqual(corroborateNowcast(NOWCAST_UP, DELTA_REV_UP), corroborateNowcast(NOWCAST_UP, DELTA_REV_UP))
  assert.deepEqual(corroborateNowcast(NOWCAST_UP, DELTA_REV_DOWN), corroborateNowcast(NOWCAST_UP, DELTA_REV_DOWN))
})

// ── 11. fail-safe — junk in, { status:'none' } out, never throws ──────────────
test('D7: malformed inputs degrade to status none without throwing', () => {
  assert.equal(corroborateNowcast(null, null).status, 'none')
  assert.equal(corroborateNowcast(undefined, undefined).status, 'none')
  assert.equal(corroborateNowcast({}, {}).status, 'none')
  assert.equal(corroborateNowcast(NOWCAST_UP, { changes: 'not-an-array' }).reason, 'no-independent-lens')
  assert.equal(corroborateNowcast(NOWCAST_UP, 42).reason, 'no-independent-lens')
})

// ── 12. label fallback — projection without a label falls to the descriptor ───
test('D7: leadLabel falls back to the metric descriptor when the projection omits one', () => {
  const nc = { status: 'projected', projections: [{ metric: 'revenue', direction: 'up', projected: 1 }] }
  const c = corroborateNowcast(nc, DELTA_REV_UP)
  assert.equal(c.status, 'corroborated')
  assert.equal(c.leadLabel, (METRICS.revenue && METRICS.revenue.label) || 'revenue')
  // An unknown metric falls all the way back to the bare id.
  const nc2 = { status: 'projected', projections: [{ metric: 'zzz_unknown', direction: 'up', projected: 1 }] }
  const c2 = corroborateNowcast(nc2, { status: 'changed', changes: [{ metric: 'zzz_unknown', direction: 'up' }] })
  assert.equal(c2.leadLabel, 'zzz_unknown')
})
