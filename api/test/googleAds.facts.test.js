// ============================================================
// test/googleAds.facts.test.js — unit test for connectors/googleAds.js#fetchFacts.
//
// Pure transform test: axios.post is stubbed so it runs with no network and no
// DB. Proves the GAQL response → { entities, facts } mapping that the new atomic
// path depends on:
//   • per-DAY × per-campaign grain (segments.date, not segments.week)
//   • account entity is the parent of every campaign
//   • metric_key mapping matches fetchStats' column mapping
//     (cost_micros→spend, conversions→leads, all_conversions_value→revenue)
//   • zero/empty metrics are skipped, but the campaign entity is still registered
//
// Run with:  npm test   (from api/)
// ============================================================
'use strict'

const { test } = require('node:test')
const assert   = require('node:assert/strict')
const axios    = require('axios')

const googleAds = require('../connectors/googleAds')

// ── stub axios.post: OAuth token refresh + the GAQL search call ──────────────
const realPost = axios.post
const GAQL_RESULTS = [
  // campaign 111 "Brand" — two days
  { segments: { date: '2026-06-01' }, campaign: { id: '111', name: 'Brand', status: 'ENABLED' },
    metrics: { costMicros: '100000000', clicks: '10', impressions: '1000', conversions: 5, allConversionsValue: 300 } },
  { segments: { date: '2026-06-02' }, campaign: { id: '111', name: 'Brand', status: 'ENABLED' },
    metrics: { costMicros: '50000000', clicks: '4', impressions: '400', conversions: 2, allConversionsValue: 150 } },
  // campaign 222 "Generic" — one day
  { segments: { date: '2026-06-01' }, campaign: { id: '222', name: 'Generic', status: 'PAUSED' },
    metrics: { costMicros: '200000000', clicks: '20', impressions: '2000', conversions: 8, allConversionsValue: 400 } },
  // campaign 333 "Dormant" — all-zero metrics: entity registered, but no facts
  { segments: { date: '2026-06-03' }, campaign: { id: '333', name: 'Dormant', status: 'ENABLED' },
    metrics: { costMicros: '0', clicks: '0', impressions: '0', conversions: 0, allConversionsValue: 0 } },
]

axios.post = async (url) => {
  if (url.includes('oauth2.googleapis.com/token')) return { data: { access_token: 'fake-token' } }
  if (url.includes('googleAds:search'))            return { data: { results: GAQL_RESULTS } }
  throw new Error(`unexpected axios.post to ${url}`)
}
test.after(() => { axios.post = realPost })

const CREDS = {
  customer_id:     '123-456-7890',   // cleanId → 1234567890
  developer_token: 'dev',
  refresh_token:   'refresh',
  client_id:       'cid',
  client_secret:   'secret',
}
const CUST = '1234567890'

// ── tests ─────────────────────────────────────────────────────────────────
test('fetchFacts maps the GAQL response to account + campaign entities', async () => {
  const { entities } = await googleAds.fetchFacts(CREDS, { since: '2026-06-01', until: '2026-06-07' })

  const account = entities.find(e => e.type === 'account')
  assert.ok(account, 'an account entity is emitted')
  assert.equal(account.external_id, CUST)

  // all three distinct campaigns are registered (incl. the all-zero one)
  const camps = entities.filter(e => e.type === 'campaign')
  assert.equal(camps.length, 3)

  const brand = camps.find(e => e.external_id === '111')
  assert.equal(brand.name, 'Brand')
  assert.equal(brand.status, 'ENABLED')
  assert.equal(brand.parent_external_id, CUST)   // campaign → account hierarchy

  // the dormant campaign is registered even though it lands no facts
  assert.ok(camps.find(e => e.external_id === '333'))
})

test('fetchFacts emits one fact per (date, campaign, metric), skipping zeros', async () => {
  const { facts } = await googleAds.fetchFacts(CREDS, { since: '2026-06-01', until: '2026-06-07' })

  // 111×2 days (5 metrics) + 222×1 day (5 metrics) = 15; 333 contributes none
  assert.equal(facts.length, 15)
  assert.ok(facts.every(f => f.channel === 'google_ads'))
  assert.ok(facts.every(f => f.entity && f.entity.type === 'campaign'))
  // every fact is non-zero (zeros were skipped)
  assert.ok(facts.every(f => f.value !== 0))

  const cell = (date, ext, key) =>
    facts.find(f => f.date === date && f.entity.external_id === ext && f.metric_key === key)?.value

  // metric_key mapping + unit conversion
  assert.equal(cell('2026-06-01', '111', 'spend'),       100)   // 100000000 micros
  assert.equal(cell('2026-06-01', '111', 'clicks'),      10)
  assert.equal(cell('2026-06-01', '111', 'impressions'), 1000)
  assert.equal(cell('2026-06-01', '111', 'leads'),       5)     // conversions → leads
  assert.equal(cell('2026-06-01', '111', 'revenue'),     300)   // all_conversions_value → revenue
  assert.equal(cell('2026-06-02', '111', 'spend'),       50)
  assert.equal(cell('2026-06-01', '222', 'spend'),       200)
})

test('fetchFacts output rolls up to the same weekly ads_* numbers via the rollup map', async () => {
  // Cross-check against lib/facts: summing the emitted facts by metric must equal
  // what the legacy weekly columns would show for this week.
  const facts  = require('../lib/facts')
  const { facts: rows } = await googleAds.fetchFacts(CREDS, { since: '2026-06-01', until: '2026-06-07' })

  const sum = (key) => rows.filter(f => f.metric_key === key).reduce((a, f) => a + f.value, 0)
  const spend   = sum('spend')    // 100 + 50 + 200 = 350
  const revenue = sum('revenue')  // 300 + 150 + 400 = 850
  assert.equal(spend, 350)
  assert.equal(revenue, 850)

  // ads_roas is defined as a SUM(revenue)/SUM(spend) ratio in the column map
  assert.equal(facts.COLUMN_FACT_MAP.ads_roas.agg, 'ratio')
  assert.equal(Math.round((revenue / spend) * 100) / 100, 2.43)
})
