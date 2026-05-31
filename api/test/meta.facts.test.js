// ============================================================
// test/meta.facts.test.js — unit test for connectors/meta.js#fetchFacts.
//
// Pure transform test: axios.get is stubbed so it runs with no network and no
// DB. Proves the Meta insights response → { entities, facts } mapping that the
// atomic path depends on:
//   • per-DAY account grain (time_increment=1 → date_start === date_stop), entity = null
//   • metric_key mapping matches fetchStats' columns
//     (spend→spend, clicks→clicks, impressions→impressions,
//      lead actions→leads, purchase/omni_purchase values→revenue)
//   • non-lead actions and non-purchase action_values are filtered out
//   • zero/empty metrics are skipped (dormant day lands no facts)
//   • spend + revenue SUM round-trip to the meta_roas ratio in the column map
//
// Run with:  npm test   (from api/)
// ============================================================
'use strict'

const { test } = require('node:test')
const assert   = require('node:assert/strict')
const axios    = require('axios')

const meta = require('../connectors/meta')

// ── stub axios.get: the insights call (meta uses a long-lived token, no OAuth) ──
const realGet = axios.get
const INSIGHTS_ROWS = [
  // 2026-06-01 — a non-lead action (link_click) and a non-revenue value (add_to_cart)
  // are mixed in to prove the action-type filters hold.
  { date_start: '2026-06-01', date_stop: '2026-06-01',
    spend: '100.50', clicks: '20', impressions: '1500',
    actions:       [{ action_type: 'lead', value: '5' }, { action_type: 'link_click', value: '99' }],
    action_values: [{ action_type: 'purchase', value: '300' }, { action_type: 'add_to_cart', value: '99' }] },
  // 2026-06-02 — the omni_* variants count too
  { date_start: '2026-06-02', date_stop: '2026-06-02',
    spend: '49.50', clicks: '10', impressions: '800',
    actions:       [{ action_type: 'omni_lead', value: '3' }],
    action_values: [{ action_type: 'omni_purchase', value: '150' }] },
  // 2026-06-03 — dormant day: all-zero metrics → no facts
  { date_start: '2026-06-03', date_stop: '2026-06-03',
    spend: '0', clicks: '0', impressions: '0', actions: [], action_values: [] },
]

axios.get = async (url) => {
  if (url.includes('/insights')) return { data: { data: INSIGHTS_ROWS } }
  throw new Error(`unexpected axios.get to ${url}`)
}
test.after(() => { axios.get = realGet })

const CREDS = { account_id: 'act_123', access_token: 'tok' }

// ── tests ─────────────────────────────────────────────────────────────────
test('fetchFacts emits account-grain facts (no entities, entity = null)', async () => {
  const { entities, facts } = await meta.fetchFacts(CREDS, { since: '2026-06-01', until: '2026-06-07' })
  assert.deepEqual(entities, [])
  assert.ok(facts.every(f => f.channel === 'meta'))
  assert.ok(facts.every(f => f.entity === null))
})

test('fetchFacts emits one fact per (day, metric), skipping zeros and non-target action types', async () => {
  const { facts } = await meta.fetchFacts(CREDS, { since: '2026-06-01', until: '2026-06-07' })

  // day1 (5 metrics) + day2 (5 metrics) + day3 dormant (0) = 10
  assert.equal(facts.length, 10)
  assert.ok(facts.every(f => f.value !== 0))

  const cell = (date, key) =>
    facts.find(f => f.date === date && f.metric_key === key)?.value

  assert.equal(cell('2026-06-01', 'spend'),       100.5)
  assert.equal(cell('2026-06-01', 'clicks'),      20)
  assert.equal(cell('2026-06-01', 'impressions'), 1500)
  assert.equal(cell('2026-06-01', 'leads'),       5)    // link_click filtered out
  assert.equal(cell('2026-06-01', 'revenue'),     300)  // add_to_cart filtered out
  assert.equal(cell('2026-06-02', 'spend'),       49.5)
  assert.equal(cell('2026-06-02', 'leads'),       3)    // omni_lead counts
  assert.equal(cell('2026-06-02', 'revenue'),     150)  // omni_purchase counts

  // dormant day lands nothing
  assert.ok(!facts.some(f => f.date === '2026-06-03'))
})

test('fetchFacts output rolls up to the meta_roas ratio via the column map', async () => {
  const factsLib = require('../lib/facts')
  const { facts: rows } = await meta.fetchFacts(CREDS, { since: '2026-06-01', until: '2026-06-07' })

  const sum = (key) => rows.filter(f => f.metric_key === key).reduce((a, f) => a + f.value, 0)
  const spend   = sum('spend')    // 100.5 + 49.5 = 150
  const revenue = sum('revenue')  // 300 + 150 = 450
  assert.equal(spend, 150)
  assert.equal(revenue, 450)

  // meta_roas is rebuilt as SUM(revenue)/SUM(spend), never emitted as a fact
  assert.equal(factsLib.COLUMN_FACT_MAP.meta_roas.agg, 'ratio')
  assert.equal(Math.round((revenue / spend) * 100) / 100, 3)
  assert.ok(!rows.some(f => f.metric_key === 'roas'))
})
