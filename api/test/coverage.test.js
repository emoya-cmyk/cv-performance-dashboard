// ============================================================
// test/coverage.test.js — per-channel connection-health watchdog (lib/coverage.js)
//
// detectCoverageGaps() flags a channel that has gone dark BEYOND ITS OWN cadence,
// emitting a `coverage_gap` finding that narrates to "reconnect this account." The
// subtlety it must get right is FAIRNESS across feed rhythms: a normally-weekly
// channel silent ~7 days is healthy, while a daily channel silent ~7 days is not.
// These tests pin: cadence estimation (incl. clamps); the days-beyond-cadence
// eligibility grace; the severity tiers; the never-connected screen-out; the
// clock-skew / fresh guards; worst-first deterministic ordering; the exact evidence
// pack + identity fields (fingerprint_key, period_start); and the hard no-op on
// empty / historyless / garbage input ("no stats" is NEVER "everything dark").
// Pure: no DB, no clock, no LLM.
// ============================================================

'use strict'

const { test } = require('node:test')
const assert   = require('node:assert/strict')

const { detectCoverageGaps, estimateCadence, daysBetween } = require('../lib/coverage')

const ASOF = '2026-06-01'

// A channel that last delivered `darkDays` before ASOF, with a history of `active`
// deliveries evenly spaced at ~`cadence` days (so estimateCadence recovers `cadence`).
function channel(key, { darkDays, cadence = 1, active = 30, label, category = 'paid' }) {
  const last  = isoMinus(ASOF, darkDays)
  const first = isoMinus(last, cadence * (active - 1))
  return {
    key,
    label: label || key,
    category,
    last_date:  last,
    first_date: first,
    active_days: active,
    span_days:  cadence * (active - 1),
  }
}

function isoMinus(iso, days) {
  const t = Date.parse(iso + 'T00:00:00Z') - days * 86400000
  return new Date(t).toISOString().slice(0, 10)
}

// ── daysBetween ─────────────────────────────────────────────────────────────
test('daysBetween: whole UTC days, sign, and null on bad input', () => {
  assert.equal(daysBetween('2026-05-25', '2026-06-01'), 7)
  assert.equal(daysBetween('2026-06-01', '2026-06-01'), 0)
  assert.equal(daysBetween('2026-06-01', '2026-05-25'), -7)   // negative when b precedes a
  assert.equal(daysBetween('2026-05-11', '2026-06-01'), 21)
  assert.equal(daysBetween(null, '2026-06-01'), null)
  assert.equal(daysBetween('2026-06-01', undefined), null)
  assert.equal(daysBetween('not-a-date', '2026-06-01'), null)
})

// ── estimateCadence ───────────────────────────────────────────────────────────
test('estimateCadence: daily, weekly, and both clamps', () => {
  assert.equal(estimateCadence(29, 30), 1)   // daily: 29 days span over 29 gaps → 1
  assert.equal(estimateCadence(28, 5),  7)   // weekly: 28 over 4 gaps → 7
  assert.equal(estimateCadence(13, 2), 13)   // two points 13 apart → 13 (under the cap)
  assert.equal(estimateCadence(100, 2), 14)  // would be 100 → clamped to 14
  assert.equal(estimateCadence(0, 5),   1)   // zero span → floor 1, never 0
  assert.equal(estimateCadence(3, 1),   3)   // gaps floored to 1 (no divide-by-zero)
})

// ── no-op guarantees: "no stats" is never "everything dark" ────────────────────
test('empty / garbage / missing-asOf input → [] (hard no-op)', () => {
  assert.deepEqual(detectCoverageGaps([], ASOF), [])
  assert.deepEqual(detectCoverageGaps(null, ASOF), [])
  assert.deepEqual(detectCoverageGaps(undefined, ASOF), [])
  assert.deepEqual(detectCoverageGaps('nonsense', ASOF), [])
  assert.deepEqual(detectCoverageGaps([channel('google_ads', { darkDays: 30 })], null), [])
  assert.deepEqual(detectCoverageGaps([null, undefined, {}], ASOF), [])   // skips junk entries
})

test('fresh channel (delivered today) → no flag', () => {
  const out = detectCoverageGaps([channel('google_ads', { darkDays: 0 })], ASOF)
  assert.deepEqual(out, [])
})

test('clock skew: last_date AFTER asOf → no flag (never negative-dark)', () => {
  const future = { key: 'meta', label: 'Meta', category: 'paid',
                   last_date: '2026-06-10', first_date: '2026-05-10',
                   active_days: 30, span_days: 31 }
  assert.deepEqual(detectCoverageGaps([future], ASOF), [])
})

// ── never-connected / barely-seen screen-out ───────────────────────────────────
test('channel with < minActiveDays history is screened out (cannot tell dropped from never-set-up)', () => {
  const oneShot = { key: 'lsa', label: 'LSA', category: 'local',
                    last_date: '2026-04-01', first_date: '2026-04-01',
                    active_days: 1, span_days: 0 }
  assert.deepEqual(detectCoverageGaps([oneShot], ASOF), [])
  // exactly at the threshold (2) it becomes eligible
  const twoShot = { key: 'lsa', label: 'LSA', category: 'local',
                    last_date: '2026-05-01', first_date: '2026-04-30',
                    active_days: 2, span_days: 1 }
  const out = detectCoverageGaps([twoShot], ASOF)
  assert.equal(out.length, 1)
  assert.equal(out[0].evidence.channel, 'lsa')
})

// ── cadence FAIRNESS: a weekly feed is not flagged at its natural ~7-day gap ─────
test('cadence fairness: weekly channel silent 7 days → no flag; daily channel silent 7 days → flagged', () => {
  const weekly = detectCoverageGaps([channel('gbp', { darkDays: 7, cadence: 7, active: 5 })], ASOF)
  assert.deepEqual(weekly, [], 'weekly feed at its own ~7d rhythm is healthy (beyond = 0)')

  const daily = detectCoverageGaps([channel('google_ads', { darkDays: 7, cadence: 1, active: 30 })], ASOF)
  assert.equal(daily.length, 1, 'daily feed dark a full week is past its rhythm')
  assert.equal(daily[0].severity, 'info')           // beyond = 7 − 1 = 6 → info (warn needs ≥ 7)
})

// NB: be exact about the tier boundaries rather than eyeballing them.
test('daily channel severity tiers on days-beyond-cadence (info≥4, warn≥7, crit≥14)', () => {
  const sev = darkDays =>
    detectCoverageGaps([channel('google_ads', { darkDays, cadence: 1, active: 30 })], ASOF)[0]?.severity || null

  assert.equal(sev(4),  null)        // beyond 3  → below info grace
  assert.equal(sev(5),  'info')      // beyond 4
  assert.equal(sev(7),  'info')      // beyond 6
  assert.equal(sev(8),  'warning')   // beyond 7
  assert.equal(sev(14), 'warning')   // beyond 13
  assert.equal(sev(15), 'critical')  // beyond 14
  assert.equal(sev(40), 'critical')
})

test('weekly channel severity tiers shift by its larger cadence', () => {
  const sev = darkDays =>
    detectCoverageGaps([channel('gbp', { darkDays, cadence: 7, active: 5 })], ASOF)[0]?.severity || null

  assert.equal(sev(7),  null)        // beyond 0
  assert.equal(sev(10), null)        // beyond 3
  assert.equal(sev(11), 'info')      // beyond 4
  assert.equal(sev(14), 'warning')   // beyond 7
  assert.equal(sev(21), 'critical')  // beyond 14
})

// ── evidence pack + identity fields ─────────────────────────────────────────────
test('finding shape: kind/scope/metric/direction + numbers-only evidence + identity fields', () => {
  const out = detectCoverageGaps(
    [channel('google_ads', { darkDays: 15, cadence: 1, active: 30, label: 'Google Ads' })],
    ASOF,
    { windowDays: 90 }
  )
  assert.equal(out.length, 1)
  const f = out[0]
  assert.equal(f.kind, 'coverage_gap')
  assert.equal(f.scope, 'client')
  assert.equal(f.metric, null)
  assert.equal(f.direction, 'down')
  assert.equal(f.severity, 'critical')         // beyond 14
  assert.equal(f.score, 14)                    // ranking magnitude = days_beyond
  assert.equal(f.period_start, isoMinus(ASOF, 15))  // stable while dark
  assert.equal(f.fingerprint_key, 'google_ads')     // distinct identity per channel

  const e = f.evidence
  assert.equal(e.channel, 'google_ads')
  assert.equal(e.channel_label, 'Google Ads')
  assert.equal(e.category, 'paid')
  assert.equal(e.days_dark, 15)
  assert.equal(e.days_beyond, 14)
  assert.equal(e.cadence_days, 1)
  assert.equal(e.last_date, isoMinus(ASOF, 15))
  assert.equal(e.expected_through, ASOF)
  assert.equal(e.active_days, 30)
  assert.equal(e.window_days, 90)
  // every NON-date evidence value the narration may quote is a finite number
  for (const k of ['days_dark', 'days_beyond', 'cadence_days', 'active_days']) {
    assert.equal(typeof e[k], 'number')
    assert.ok(Number.isFinite(e[k]))
  }
})

test('window_days defaults to null when not supplied', () => {
  const [f] = detectCoverageGaps([channel('meta', { darkDays: 15, cadence: 1, active: 30 })], ASOF)
  assert.equal(f.evidence.window_days, null)
})

// ── multi-channel ranking ───────────────────────────────────────────────────────
test('multiple dark channels rank worst-first (severity desc, then beyond desc), deterministically', () => {
  const input = [
    channel('gbp',        { darkDays: 11, cadence: 7, active: 5 }),   // beyond 4   → info
    channel('google_ads', { darkDays: 40, cadence: 1, active: 30 }),  // beyond 39  → critical
    channel('meta',       { darkDays: 8,  cadence: 1, active: 30 }),  // beyond 7   → warning
    channel('ga4',        { darkDays: 0,  cadence: 1, active: 30 }),  // fresh      → dropped
  ]
  // pass scrambled; output order must not depend on input order
  const out = detectCoverageGaps(input.slice().reverse(), ASOF)
  assert.deepEqual(out.map(f => f.fingerprint_key), ['google_ads', 'meta', 'gbp'])
  assert.deepEqual(out.map(f => f.severity), ['critical', 'warning', 'info'])
})

test('equal severity ties break by days_beyond desc, then key asc', () => {
  const out = detectCoverageGaps([
    channel('meta',       { darkDays: 9,  cadence: 1, active: 30 }),  // beyond 8 warning
    channel('google_ads', { darkDays: 12, cadence: 1, active: 30 }),  // beyond 11 warning
    channel('lsa',        { darkDays: 12, cadence: 1, active: 30, category: 'local' }), // beyond 11 warning (tie w/ google_ads)
  ], ASOF)
  assert.deepEqual(out.map(f => f.severity), ['warning', 'warning', 'warning'])
  // 11 (google_ads) and 11 (lsa) tie on beyond → key asc; then 8 (meta) last
  assert.deepEqual(out.map(f => f.fingerprint_key), ['google_ads', 'lsa', 'meta'])
})

// ── opts overrides ──────────────────────────────────────────────────────────────
test('opts can tighten/loosen the grace and tiers', () => {
  // With a stricter info grace of 1 day, a daily channel dark 3 days (beyond 2) now flags.
  const strict = detectCoverageGaps(
    [channel('google_ads', { darkDays: 3, cadence: 1, active: 30 })],
    ASOF,
    { infoDays: 1 }
  )
  assert.equal(strict.length, 1)
  assert.equal(strict[0].severity, 'info')

  // Default grace (4) drops that same channel.
  const lax = detectCoverageGaps([channel('google_ads', { darkDays: 3, cadence: 1, active: 30 })], ASOF)
  assert.deepEqual(lax, [])
})

test('span_days is derived from first/last when not supplied', () => {
  // omit span_days; module must recompute it from first_date→last_date
  const last  = isoMinus(ASOF, 15)
  const first = isoMinus(last, 29)            // 30 daily deliveries → cadence 1
  const ch = { key: 'google_ads', label: 'Google Ads', category: 'paid',
               last_date: last, first_date: first, active_days: 30 }   // no span_days
  const [f] = detectCoverageGaps([ch], ASOF)
  assert.equal(f.evidence.cadence_days, 1)
  assert.equal(f.evidence.days_beyond, 14)
  assert.equal(f.severity, 'critical')
})
