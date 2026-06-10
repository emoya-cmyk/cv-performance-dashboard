// ============================================================
// test/query.schema.test.js — the self-describing catalog behind
// GET /api/query/schema is exactly the allow-list the compiler enforces.
//
// A UI renders its controls from catalog(); the query endpoint validates against
// the SAME METRICS / DIMENSIONS / DATE_GRAINS / channel maps. These tests pin
// that they can never drift apart: every advertised id must be a real, queryable
// id, and nothing private (formulas, num/den, metric_key, SQL) leaks out.
// Pure function — no DB, no migration, no HTTP.
// ============================================================

'use strict'

const { test } = require('node:test')
const assert   = require('node:assert/strict')

const registry = require('../semantic/registry')
const { catalog, METRICS, DIMENSIONS, DATE_GRAINS, validateQuerySpec } =
  { ...registry, ...require('../semantic/compile') }

test('catalog: every advertised metric is a real registry metric, no extras', () => {
  const cat = catalog()
  const ids = cat.metrics.map(m => m.id)

  // exact bijection with the registry — nothing advertised that the compiler
  // would reject, nothing queryable that the UI can't see
  assert.deepEqual(new Set(ids), new Set(Object.keys(METRICS)))
  assert.equal(ids.length, Object.keys(METRICS).length)        // no dupes

  // a few anchors so a careless registry edit is caught here
  const byId = Object.fromEntries(cat.metrics.map(m => [m.id, m]))
  assert.deepEqual(byId.spend, { id: 'spend', label: 'Spend', format: 'currency', kind: 'sum' })
  assert.equal(byId.roas.kind, 'ratio')
  assert.equal(byId.roas.format, 'multiple')
  assert.equal(byId.engagement_rate.kind, 'avg')
})

test('catalog: only public fields are exposed (no formulas / metric_key / SQL)', () => {
  const allowed = new Set(['id', 'label', 'format', 'kind'])
  for (const m of catalog().metrics) {
    for (const k of Object.keys(m)) {
      assert.ok(allowed.has(k), `metric ${m.id} leaks private field "${k}"`)
    }
    // explicit belt-and-suspenders: the compiler-internal keys must be absent
    assert.equal(m.num, undefined)
    assert.equal(m.den, undefined)
    assert.equal(m.metric_key, undefined)
    assert.equal(m.scale, undefined)
  }
})

test('catalog: dimensions and date grains mirror the registry', () => {
  const cat = catalog()
  assert.deepEqual(new Set(cat.dimensions.map(d => d.id)), new Set(Object.keys(DIMENSIONS)))
  assert.deepEqual(cat.dateGrains, [...DATE_GRAINS])
  // sanity: the two non-date dims the compiler knows
  assert.deepEqual(cat.dimensions.map(d => d.id).sort(), ['channel', 'client'])
  assert.deepEqual(cat.dateGrains, ['day', 'week', 'month'])
})

test('catalog: channels are the modelled set, id-ordered, fully labelled', () => {
  const channels = catalog().channels
  assert.equal(channels.length, 11)
  assert.deepEqual(channels.map(c => c.key), [
    'google_ads', 'meta', 'lsa', 'gbp', 'ga4', 'ghl', 'organic',
    'callrail', 'housecallpro', 'bing_ads', 'youtube',
  ])
  assert.deepEqual(channels.map(c => c.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  for (const c of channels) {
    assert.equal(typeof c.label, 'string')
    assert.ok(c.label.length > 0, `channel ${c.key} missing a label`)
  }
})

test('catalog ↔ compiler: every advertised metric actually validates', () => {
  // The real anti-drift guarantee: feed each advertised id straight into the
  // validator the POST endpoint uses. If the catalog ever advertised a metric
  // the compiler rejects, this throws.
  for (const m of catalog().metrics) {
    assert.doesNotThrow(() =>
      validateQuerySpec({
        metrics:   [m.id],
        dateRange: { start: '2026-01-01', end: '2026-01-31' },
      }),
      `advertised metric "${m.id}" failed compiler validation`)
  }
  // and each advertised channel key is accepted as a filter value
  for (const c of catalog().channels) {
    assert.doesNotThrow(() =>
      validateQuerySpec({
        metrics:   ['spend'],
        dateRange: { start: '2026-01-01', end: '2026-01-31' },
        filters:   [{ dim: 'channel', op: 'in', values: [c.key] }],
      }),
      `advertised channel "${c.key}" rejected as a filter value`)
  }
})
