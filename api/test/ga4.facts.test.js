// ============================================================
// test/ga4.facts.test.js — unit test for connectors/ga4.js#fetchFacts.
//
// Pure transform test: axios.post is stubbed (OAuth refresh + runReport) so it
// runs with no network and no DB. Proves the GA4 runReport response →
// { entities, facts } mapping, and — the load-bearing case — the engagement_rate
// parity design:
//   • the 6 additive metrics (sessions, new_users, conversions,
//     organic/paid/direct_sessions) are emitted PER DAY
//   • engagement_rate is emitted as exactly ONE fact PER WEEK, dated on the
//     week's Monday, as the sessions-WEIGHTED weekly rate (Σengaged / Σsessions),
//     NOT an unweighted average of daily rates. The rollup aggregates 'avg'
//     columns with an unweighted SQL AVG, so AVG-over-one-value returns it
//     unchanged → exact parity with fetchStats.
//   • channel bucketing is specific (organic search / paid / direct); other
//     channel groups count toward total sessions only
//   • zeros skipped, account grain (entity = null)
//
// Run with:  npm test   (from api/)
// ============================================================
'use strict'

const { test } = require('node:test')
const assert   = require('node:assert/strict')
const axios    = require('axios')

const ga4 = require('../connectors/ga4')

// ── stub axios.post: OAuth token refresh + the runReport call ────────────────
// 2026-06-01 (Mon), 06-02 (Tue), 06-03 (Wed) all fall in the week starting
// Monday 2026-06-01, so they accumulate into ONE engagement_rate fact.
const realPost = axios.post
const row = (ymd, channel, sessions, newUsers, conversions, engaged) => ({
  dimensionValues: [{ value: ymd }, { value: channel }],
  metricValues:    [{ value: String(sessions) }, { value: String(newUsers) },
                    { value: String(conversions) }, { value: String(engaged) }],
})
const GA4_RESPONSE = {
  dimensionHeaders: [{ name: 'date' }, { name: 'sessionDefaultChannelGroup' }],
  metricHeaders:    [{ name: 'sessions' }, { name: 'newUsers' },
                     { name: 'conversions' }, { name: 'engagedSessions' }],
  rows: [
    row('20260601', 'Organic Search', 100, 40, 5, 60),
    row('20260601', 'Paid Search',     20, 10, 2, 15),
    row('20260602', 'Direct',           1,  1, 0,  0),
    row('20260603', 'Organic Social',  10,  5, 1,  8),  // not bucketed; counts toward total sessions
  ],
}

axios.post = async (url) => {
  if (url.includes('oauth2.googleapis.com/token')) return { data: { access_token: 'fake-token' } }
  if (url.includes(':runReport'))                  return { data: GA4_RESPONSE }
  throw new Error(`unexpected axios.post to ${url}`)
}
test.after(() => { axios.post = realPost })

const CREDS = {
  property_id:   '123456789',
  client_id:     'cid',
  client_secret: 'secret',
  refresh_token: 'refresh',
}

// ── tests ─────────────────────────────────────────────────────────────────
test('fetchFacts emits account-grain facts (no entities, entity = null)', async () => {
  const { entities, facts } = await ga4.fetchFacts(CREDS, { since: '2026-06-01', until: '2026-06-07' })
  assert.deepEqual(entities, [])
  assert.ok(facts.every(f => f.channel === 'ga4'))
  assert.ok(facts.every(f => f.entity === null))
})

test('fetchFacts emits the 6 additive metrics per day, bucketing channels, skipping zeros', async () => {
  const { facts } = await ga4.fetchFacts(CREDS, { since: '2026-06-01', until: '2026-06-07' })

  const cell = (date, key) =>
    facts.find(f => f.date === date && f.metric_key === key)?.value

  // 06-01 — two channel rows merge per day; direct = 0 → skipped
  assert.equal(cell('2026-06-01', 'sessions'),         120)  // 100 + 20
  assert.equal(cell('2026-06-01', 'new_users'),        50)   // 40 + 10
  assert.equal(cell('2026-06-01', 'conversions'),      7)    // 5 + 2
  assert.equal(cell('2026-06-01', 'organic_sessions'), 100)  // Organic Search only
  assert.equal(cell('2026-06-01', 'paid_sessions'),    20)   // Paid Search
  assert.equal(cell('2026-06-01', 'direct_sessions'),  undefined)

  // 06-02 — Direct day: only sessions, new_users, direct_sessions land
  assert.equal(cell('2026-06-02', 'sessions'),        1)
  assert.equal(cell('2026-06-02', 'direct_sessions'), 1)
  assert.equal(cell('2026-06-02', 'conversions'),     undefined)  // 0 skipped

  // 06-03 — Organic Social is NOT bucketed into organic/paid/direct, but counts in sessions
  assert.equal(cell('2026-06-03', 'sessions'),         10)
  assert.equal(cell('2026-06-03', 'organic_sessions'), undefined)
})

test('engagement_rate is ONE sessions-weighted fact per week, Monday-dated', async () => {
  const factsLib = require('../lib/facts')
  const { facts } = await ga4.fetchFacts(CREDS, { since: '2026-06-01', until: '2026-06-07' })

  const erFacts = facts.filter(f => f.metric_key === 'engagement_rate')
  // exactly one — proves it is NOT emitted per day
  assert.equal(erFacts.length, 1)

  const er = erFacts[0]
  assert.equal(er.date, '2026-06-01')   // the week's Monday
  assert.equal(er.entity, null)

  // weighted weekly rate = Σengaged / Σsessions = (60+15+0+8) / (120+1+10)
  //                      = 83 / 131 * 100 = 63.4 (toFixed(1))
  assert.equal(er.value, 63.4)

  // sanity: the WEIGHTED value must NOT equal the unweighted average of daily
  // rates ((75/120 + 0/1 + 8/10)/3 *100 = 47.5) — that divergence is the whole
  // reason for the per-week design.
  assert.notEqual(er.value, 47.5)

  // engagement_rate aggregates as 'avg' in the column map (AVG-over-one = itself)
  assert.equal(factsLib.COLUMN_FACT_MAP.ga4_engagement_rate.agg, 'avg')
})
