// ============================================================
// test/lsa.facts.test.js — unit test for connectors/lsa.js#fetchFacts.
//
// Pure transform test: axios.post is stubbed (OAuth token refresh + the GAQL
// search call) so it runs with no network and no DB. Proves:
//   • per-DAY account grain (segments.date), entity = null
//   • multiple lead rows on the same day are summed
//   • ONLY spend + calls are emitted — parity with fetchStats (lsa_impressions /
//     lsa_booked_jobs exist in the column map but fetchStats never populates them)
//   • zero metrics skipped (a calls-only day still lands its calls fact)
//   • the empty-fallback: an unavailable local_services_lead resource yields
//     { entities: [], facts: [] } instead of throwing
//
// Run with:  npm test   (from api/)
// ============================================================
'use strict'

const { test } = require('node:test')
const assert   = require('node:assert/strict')
const axios    = require('axios')

const lsa = require('../connectors/lsa')

// ── stub axios.post: OAuth token refresh + the GAQL search call ──────────────
// SEARCH_MODE lets one test force the search call to throw (empty-fallback path).
let SEARCH_MODE = 'ok'
const realPost = axios.post
const LSA_RESULTS = [
  // 2026-06-01 — two lead rows, summed: spend 100+50=150, calls 2+1=3
  { segments: { date: '2026-06-01' }, metrics: { costMicros: '100000000', phoneCalls: '2' },
    localServicesLead: { leadType: 'PHONE_CALL' } },
  { segments: { date: '2026-06-01' }, metrics: { costMicros: '50000000', phoneCalls: '1' },
    localServicesLead: { leadType: 'PHONE_CALL' } },
  // 2026-06-02 — zero spend, 3 calls: spend skipped, calls fact lands
  { segments: { date: '2026-06-02' }, metrics: { costMicros: '0', phoneCalls: '3' },
    localServicesLead: { leadType: 'MESSAGE' } },
]

axios.post = async (url) => {
  if (url.includes('oauth2.googleapis.com/token')) return { data: { access_token: 'fake-token' } }
  if (url.includes('googleAds:search')) {
    if (SEARCH_MODE === 'throw') throw new Error('local_services_lead not available for this account')
    return { data: { results: LSA_RESULTS } }
  }
  throw new Error(`unexpected axios.post to ${url}`)
}
test.after(() => { axios.post = realPost })

const CREDS = {
  customer_id:     '123-456-7890',
  developer_token: 'dev',
  refresh_token:   'refresh',
  client_id:       'cid',
  client_secret:   'secret',
}

// ── tests ─────────────────────────────────────────────────────────────────
test('fetchFacts emits per-day spend + calls only, summing same-day rows', async () => {
  const { entities, facts } = await lsa.fetchFacts(CREDS, { since: '2026-06-01', until: '2026-06-07' })

  assert.deepEqual(entities, [])
  assert.ok(facts.every(f => f.channel === 'lsa'))
  assert.ok(facts.every(f => f.entity === null))
  // only spend + calls are ever emitted
  assert.ok(facts.every(f => f.metric_key === 'spend' || f.metric_key === 'calls'))

  // day1: spend (2 rows summed) + calls (2 rows summed) = 2 facts; day2: calls only = 1
  assert.equal(facts.length, 3)

  const cell = (date, key) =>
    facts.find(f => f.date === date && f.metric_key === key)?.value

  assert.equal(cell('2026-06-01', 'spend'), 150)  // 100 + 50
  assert.equal(cell('2026-06-01', 'calls'), 3)    // 2 + 1
  assert.equal(cell('2026-06-02', 'spend'), undefined)  // zero spend skipped
  assert.equal(cell('2026-06-02', 'calls'), 3)
})

test('fetchFacts falls back to empty when local_services_lead is unavailable', async () => {
  SEARCH_MODE = 'throw'
  try {
    const out = await lsa.fetchFacts(CREDS, { since: '2026-06-01', until: '2026-06-07' })
    assert.deepEqual(out, { entities: [], facts: [] })
  } finally {
    SEARCH_MODE = 'ok'
  }
})
