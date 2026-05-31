// ============================================================
// test/gbp.facts.test.js — unit test for connectors/gbp.js#fetchFacts.
//
// Pure transform test: axios.post (OAuth refresh) and axios.get (per-metric
// getDailyMetrics) are stubbed so it runs with no network and no DB. Proves:
//   • per-DAY account grain (the Performance API is already daily), entity = null
//   • metric_key mapping matches fetchStats
//     (CALL_CLICKS→calls, DIRECTION_REQUESTS→directions,
//      WEBSITE_CLICKS→website_clicks, BUSINESS_SEARCHES→searches)
//   • views = desktop + mobile search impressions, summed per day
//   • zero metrics skipped (a views-only day still lands its views fact)
//
// Run with:  npm test   (from api/)
// ============================================================
'use strict'

const { test } = require('node:test')
const assert   = require('node:assert/strict')
const axios    = require('axios')

const gbp = require('../connectors/gbp')

// ── stub axios.post (OAuth) + axios.get (per-metric daily series) ─────────────
// Each metric returns its own datedValues series; the stub branches on the
// dailyMetric query param. views is desktop + mobile summed, so those two
// series differ and we assert they add up per day.
const realPost = axios.post
const realGet  = axios.get

const d = (day, value) => ({ date: { year: 2026, month: 6, day }, value })
const SERIES = {
  CALL_CLICKS:                         [d(1, '12'), d(2, '0')],   // day2 zero → skipped
  DIRECTION_REQUESTS:                  [d(1, '5')],
  WEBSITE_CLICKS:                      [d(1, '8')],
  BUSINESS_IMPRESSIONS_DESKTOP_SEARCH: [d(1, '100'), d(2, '50')],
  BUSINESS_IMPRESSIONS_MOBILE_SEARCH:  [d(1, '200'), d(2, '70')],
  BUSINESS_SEARCHES:                   [d(1, '30')],
}

axios.post = async (url) => {
  if (url.includes('oauth2.googleapis.com/token')) return { data: { access_token: 'fake-token' } }
  throw new Error(`unexpected axios.post to ${url}`)
}
axios.get = async (url, config) => {
  if (url.includes(':getDailyMetrics')) {
    const m = config.params.dailyMetric
    return { data: { timeSeries: { datedValues: SERIES[m] || [] } } }
  }
  throw new Error(`unexpected axios.get to ${url}`)
}
test.after(() => { axios.post = realPost; axios.get = realGet })

const CREDS = {
  location_id:   '999',
  refresh_token: 'refresh',
  client_id:     'cid',
  client_secret: 'secret',
}

// ── tests ─────────────────────────────────────────────────────────────────
test('fetchFacts emits account-grain daily facts (no entities, entity = null)', async () => {
  const { entities, facts } = await gbp.fetchFacts(CREDS, { since: '2026-06-01', until: '2026-06-07' })
  assert.deepEqual(entities, [])
  assert.ok(facts.every(f => f.channel === 'gbp'))
  assert.ok(facts.every(f => f.entity === null))
})

test('fetchFacts maps metrics, sums desktop+mobile into views, skips zeros', async () => {
  const { facts } = await gbp.fetchFacts(CREDS, { since: '2026-06-01', until: '2026-06-07' })

  // day1: calls, directions, website_clicks, views, searches = 5
  // day2: views only (calls=0 skipped) = 1
  assert.equal(facts.length, 6)
  assert.ok(facts.every(f => f.value !== 0))

  const cell = (date, key) =>
    facts.find(f => f.date === date && f.metric_key === key)?.value

  assert.equal(cell('2026-06-01', 'calls'),          12)
  assert.equal(cell('2026-06-01', 'directions'),     5)
  assert.equal(cell('2026-06-01', 'website_clicks'), 8)
  assert.equal(cell('2026-06-01', 'searches'),       30)
  assert.equal(cell('2026-06-01', 'views'),          300)  // 100 desktop + 200 mobile
  // day2: only views survives (desktop 50 + mobile 70); calls=0 was skipped
  assert.equal(cell('2026-06-02', 'views'),          120)
  assert.equal(cell('2026-06-02', 'calls'),          undefined)
})
