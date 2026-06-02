// ============================================================
// test/pacing.test.js — "at this rate, does the client hit their monthly goal?"
//
// lib/pacing.js takes a client's month-to-date actual against a human-set monthly
// target and projects month-end by plain linear run-rate (actual ÷ elapsed-share),
// then bands the result: ahead / on_track / behind / at_risk — with an 'early' guard
// that withholds the alarm band while the month is too young to trust, and a 'none'
// no-op when no target is set. These tests hand-trace the projection, attainment,
// catch-up rate, and status on fixed day-counts; pin the early-month and no-goal
// honesty paths; pin the closed-month (no days remaining) edge; and prove the roster
// keeps only the goals needing a human, worst-pace-first. Pure: same numbers always
// yield the same verdict, inputs never mutated. No DB, no clock, no LLM.
// ============================================================

'use strict'

const { test } = require('node:test')
const assert   = require('node:assert/strict')

const {
  classifyPacing, rankPacing, paceStatus,
  MIN_ELAPSED, AHEAD_AT, ON_TRACK_AT, BEHIND_AT, STATUS_RANK,
} = require('../lib/pacing')

// a pacing row for the roster / classifier (10 of 30 days gone unless overridden)
const row = (client_id, target, actual, extra = {}) => ({
  client_id, client_name: client_id, metric: 'leads',
  target, actual, daysElapsed: 10, daysInMonth: 30, ...extra,
})

// ---- degenerate / no-goal: a quiet, alarm-free no-op, never a throw ----------------

test('classifyPacing: no target / garbage → a status:none no-op', () => {
  for (const input of [{}, null, undefined, { target: 0, actual: 5, daysElapsed: 10, daysInMonth: 30 },
                       { target: -5, actual: 5, daysElapsed: 10, daysInMonth: 30 },
                       { target: 'x', actual: 'y' }, { metric: 'leads', target: NaN }]) {
    const v = classifyPacing(input)
    assert.equal(v.status, 'none')
    assert.equal(v.projected, null)
    assert.equal(v.attainment, null)
    assert.equal(v.confidence, null)
  }
})

test('classifyPacing: a target but a degenerate month (no days) → none no-op, target preserved', () => {
  const v = classifyPacing({ metric: 'jobs', target: 20, actual: 4, daysElapsed: 0, daysInMonth: 0 })
  assert.equal(v.status, 'none')
  assert.equal(v.target, 20)            // the goal is echoed even when we can't pace it
  assert.equal(v.projected, null)
})

// ---- the four live bands, hand-traced on 10 of 30 days ------------------------------

test('classifyPacing: at_risk — 10 leads in 10 days against 50 projects to 30 (60%)', () => {
  const v = classifyPacing(row('acme', 50, 10))
  assert.equal(v.projected, 30)         // 1.0/day × 30 days
  assert.equal(v.attainment, 0.6)       // 30 / 50
  assert.equal(v.gap, -20)              // 30 − 50
  assert.equal(v.remaining, 40)         // 50 − 10 still to do
  assert.equal(v.shortfall, 20)         // projected miss
  assert.equal(v.current_rate, 1)       // 10 / 10 days
  assert.equal(v.required_rate, 2)      // 40 remaining / 20 days left
  assert.equal(v.catchup, 2)            // must run 2× the current pace
  assert.equal(v.days_remaining, 20)
  assert.equal(v.confidence, 0.33)      // 10/30 of the month observed
  assert.equal(v.status, 'at_risk')
})

test('classifyPacing: behind — 14 → projects to 42 (84%)', () => {
  const v = classifyPacing(row('beta', 50, 14))
  assert.equal(v.projected, 42)
  assert.equal(v.attainment, 0.84)
  assert.equal(v.shortfall, 8)
  assert.equal(v.required_rate, 1.8)    // 36 / 20
  assert.equal(v.catchup, 1.29)         // 1.8 / 1.4
  assert.equal(v.status, 'behind')
})

test('classifyPacing: on_track — 16 → projects to 48 (96%), inside the dead-zone', () => {
  const v = classifyPacing(row('gamma', 50, 16))
  assert.equal(v.projected, 48)
  assert.equal(v.attainment, 0.96)
  assert.equal(v.shortfall, 2)
  assert.equal(v.status, 'on_track')    // 0.96 ≥ 0.92 → not alarmed despite a small miss
})

test('classifyPacing: ahead — 20 → projects to 60 (120%); already past pace, no catch-up', () => {
  const v = classifyPacing(row('delta', 50, 20))
  assert.equal(v.projected, 60)
  assert.equal(v.attainment, 1.2)
  assert.equal(v.gap, 10)
  assert.equal(v.shortfall, 0)          // no projected miss
  assert.equal(v.catchup, null)         // running ahead of the required rate
  assert.equal(v.status, 'ahead')
})

// ---- honesty: the early-month guard withholds the alarm band -----------------------

test('classifyPacing: early — only 3 of 30 days gone → status early, numbers still reported', () => {
  const v = classifyPacing(row('young', 50, 2, { daysElapsed: 3 }))
  assert.equal(v.status, 'early')       // 0.10 elapsed < MIN_ELAPSED, despite a grim 0.4 attainment
  assert.equal(v.attainment, 0.4)       // 20 / 50 — reported, just not banded as a hard call
  assert.equal(v.confidence, 0.1)       // honestly low
})

test('classifyPacing: the guard is overridable via opts.minElapsed (so a band can be forced)', () => {
  const v = classifyPacing(row('young', 50, 2, { daysElapsed: 3 }), { minElapsed: 0 })
  assert.equal(v.status, 'at_risk')     // same numbers, guard lifted → the real band shows
})

// ---- closed-month edge: no days remaining ------------------------------------------

test('classifyPacing: month closed (30/30) → projection equals actual, no required/catch-up', () => {
  const v = classifyPacing(row('done', 50, 45, { daysElapsed: 30 }))
  assert.equal(v.days_remaining, 0)
  assert.equal(v.projected, 45)         // elapsed = 1 → run-rate IS the actual
  assert.equal(v.attainment, 0.9)
  assert.equal(v.required_rate, null)   // nowhere left to run
  assert.equal(v.catchup, null)
  assert.equal(v.confidence, 1)         // the whole month observed
  assert.equal(v.status, 'behind')      // 0.90 < 0.92
})

test('classifyPacing: daysElapsed past month length is capped (no over-100% elapsed)', () => {
  const v = classifyPacing(row('over', 50, 50, { daysElapsed: 35, daysInMonth: 30 }))
  assert.equal(v.days_elapsed, 30)      // capped at the month length
  assert.equal(v.elapsed, 1)
  assert.equal(v.projected, 50)
  assert.equal(v.status, 'on_track')    // exactly 1.0
})

// ---- paceStatus band edges (the bands are the contract) ----------------------------

test('paceStatus: the documented band edges', () => {
  assert.equal(paceStatus(1.05), 'ahead')
  assert.equal(paceStatus(1.04), 'on_track')
  assert.equal(paceStatus(0.92), 'on_track')
  assert.equal(paceStatus(0.9199), 'behind')
  assert.equal(paceStatus(0.75), 'behind')
  assert.equal(paceStatus(0.7499), 'at_risk')
  assert.equal(paceStatus(0), 'at_risk')
})

// ---- roster: only the goals needing a human, worst-pace-first ----------------------

test('rankPacing: keeps behind+at_risk, drops on_track/ahead/early/none, orders worst-first', () => {
  const rows = [
    row('on',   50, 16),                       // on_track → out
    row('ahd',  50, 20),                       // ahead → out
    row('none', 0,  5),                        // no goal → out
    row('early',50, 2, { daysElapsed: 3 }),    // early → out
    row('mild', 50, 14),                       // behind, 0.84
    row('bad',  50, 10),                       // at_risk, 0.60
    row('worst',100, 15),                      // at_risk, 0.45 (projects 45/100)
  ]
  const roster = rankPacing(rows)
  assert.deepEqual(roster.map(r => r.client_id), ['worst', 'bad', 'mild'])
  assert.equal(roster[0].status, 'at_risk')
  assert.equal(roster[0].attainment, 0.45)
  assert.equal(roster[2].status, 'behind')
})

test('rankPacing: garbage in → [], null rows skipped', () => {
  assert.deepEqual(rankPacing(null), [])
  assert.deepEqual(rankPacing(undefined), [])
  assert.deepEqual(rankPacing([null, undefined, {}]), [])   // {} → none → excluded
})

// ---- purity: same numbers → same verdict, inputs never mutated ---------------------

test('classifyPacing: pure — frozen input does not throw and repeats identically', () => {
  const input = Object.freeze({ metric: 'revenue', target: 50, actual: 10, daysElapsed: 10, daysInMonth: 30 })
  const a = classifyPacing(input)
  const b = classifyPacing(input)
  assert.deepEqual(a, b)
  assert.equal(a.metric, 'revenue')     // metric echoed through untouched
})

test('rankPacing: pure — the same rows yield an identical roster', () => {
  const rows = [row('a', 50, 10), row('b', 50, 14)]
  assert.deepEqual(rankPacing(rows), rankPacing(rows))
})

// ---- constants: documented defaults ------------------------------------------------

test('constants: documented defaults', () => {
  assert.equal(MIN_ELAPSED, 0.15)
  assert.equal(AHEAD_AT, 1.05)
  assert.equal(ON_TRACK_AT, 0.92)
  assert.equal(BEHIND_AT, 0.75)
  assert.equal(STATUS_RANK.at_risk, 2)
  assert.equal(STATUS_RANK.behind, 1)
})
