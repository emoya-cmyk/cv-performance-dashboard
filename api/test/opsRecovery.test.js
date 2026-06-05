'use strict'

// Unit tests for the self-healing CLOSURE planner (lib/opsRecovery). Pure decision
// module → pure tests, zero mocking. Covers the four safety guards (allow-list,
// status gate, cooldown, per-cycle cap), the hard deny-list, deterministic priority,
// the clock fail-safe, input purity, and end-to-end shape compatibility with the real
// assessOps grader it consumes.

const { test } = require('node:test')
const assert = require('node:assert/strict')

const {
  planJobRecovery,
  isRecoverable,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_MAX_PER_CYCLE,
  DEFAULT_RECOVER_STATUSES,
  NEVER_RECOVERABLE,
} = require('../lib/opsRecovery')
const { assessOps } = require('../lib/opsHealth')

const H = 60 * 60 * 1000          // one hour in ms
const NOW = 1_700_000_000_000     // fixed epoch ms — deterministic, no clock reads

// Minimal job-assessment + assessment builders. planJobRecovery reads only these
// fields, so hand-building keeps each test focused on the decision under test.
const job = (name, status, overdueByMs = 0, ageMs = 0) => ({ job: name, status, overdueByMs, ageMs })
const assess = (jobs) => ({ jobs })

// ── Guard 1: allow-list ───────────────────────────────────────────────────────────

test('recovers an overdue job that is on the allow-list', () => {
  const a = assess([job('insights', 'overdue', 4 * H, 40 * H)])
  const { recover, skipped } = planJobRecovery({
    assessment: a, recoverable: ['insights'], now: NOW, cooldownLedger: {},
  })
  assert.equal(recover.length, 1)
  assert.equal(recover[0].job, 'insights')
  assert.equal(recover[0].reason, 'due')
  assert.equal(recover[0].overdueByMs, 4 * H)
  assert.equal(skipped.length, 0)
})

test('never recovers a job absent from the allow-list', () => {
  const a = assess([job('insights', 'stale', 100 * H, 200 * H)])
  const { recover } = planJobRecovery({ assessment: a, recoverable: [], now: NOW })
  assert.equal(recover.length, 0)
})

test('default (empty) allow-list heals nothing — fail-closed', () => {
  const a = assess([job('insights', 'overdue', 4 * H, 40 * H)])
  const { recover } = planJobRecovery({ assessment: a, now: NOW })
  assert.equal(recover.length, 0)
})

// ── Class-C hard deny-list ──────────────────────────────────────────────────────────

test('hard deny-list: digest and watchdog are never recoverable even if allow-listed', () => {
  const a = assess([
    job('digest', 'stale', 50 * H, 100 * H),
    job('watchdog', 'stale', 50 * H, 100 * H),
  ])
  const { recover } = planJobRecovery({
    assessment: a, recoverable: ['digest', 'watchdog', 'insights'], now: NOW,
  })
  assert.equal(recover.length, 0)
})

// ── Guard 2: status gate ────────────────────────────────────────────────────────────

test('status gate: live and never jobs are never recovered', () => {
  const a = assess([
    job('insights', 'live', 0, 1 * H),
    job('sync', 'never', 0, 0),
  ])
  const { recover } = planJobRecovery({ assessment: a, recoverable: ['insights', 'sync'], now: NOW })
  assert.equal(recover.length, 0)
})

// ── Guard 3: cooldown ───────────────────────────────────────────────────────────────

test('cooldown thrash-guard: skips a job attempted within the cooldown window', () => {
  const a = assess([job('insights', 'overdue', 4 * H, 40 * H)])
  const ledger = { insights: NOW - 1 * H }   // attempted 1h ago; cooldown is 2h
  const { recover, skipped } = planJobRecovery({
    assessment: a, recoverable: ['insights'], now: NOW, cooldownLedger: ledger,
  })
  assert.equal(recover.length, 0)
  assert.equal(skipped.length, 1)
  assert.equal(skipped[0].reason, 'cooldown')
})

test('cooldown clears once the window has elapsed', () => {
  const a = assess([job('insights', 'overdue', 4 * H, 40 * H)])
  const ledger = { insights: NOW - 3 * H }   // 3h ago > 2h cooldown
  const { recover } = planJobRecovery({
    assessment: a, recoverable: ['insights'], now: NOW, cooldownLedger: ledger,
  })
  assert.equal(recover.length, 1)
})

test('cooldown accepts an ISO-string ledger stamp (toMs-normalized)', () => {
  const a = assess([job('insights', 'overdue', 4 * H, 40 * H)])
  const ledger = { insights: new Date(NOW - 30 * 60 * 1000).toISOString() } // 30m ago
  const { recover, skipped } = planJobRecovery({
    assessment: a, recoverable: ['insights'], now: NOW, cooldownLedger: ledger,
  })
  assert.equal(recover.length, 0)
  assert.equal(skipped[0].reason, 'cooldown')
})

// ── Guard 4: per-cycle cap + deterministic priority ─────────────────────────────────

test('per-cycle cap recovers only the most-overdue, skips the rest as cap', () => {
  const a = assess([
    job('a', 'overdue', 1 * H, 10 * H),
    job('b', 'overdue', 9 * H, 30 * H),
    job('c', 'overdue', 5 * H, 20 * H),
  ])
  const { recover, skipped } = planJobRecovery({
    assessment: a, recoverable: ['a', 'b', 'c'], now: NOW, maxPerCycle: 2, cooldownLedger: {},
  })
  assert.deepEqual(recover.map((r) => r.job), ['b', 'c'])  // most-overdue first
  assert.equal(skipped.length, 1)
  assert.equal(skipped[0].job, 'a')
  assert.equal(skipped[0].reason, 'cap')
})

test('deterministic tie-break: equal overdue+age → lexicographic job name', () => {
  const a = assess([
    job('zeta', 'overdue', 5 * H, 10 * H),
    job('alpha', 'overdue', 5 * H, 10 * H),
  ])
  const { recover } = planJobRecovery({
    assessment: a, recoverable: ['zeta', 'alpha'], now: NOW, maxPerCycle: 1,
  })
  assert.equal(recover.length, 1)
  assert.equal(recover[0].job, 'alpha')   // 'alpha' < 'zeta'
})

test('maxPerCycle of 0 recovers nothing (every candidate capped)', () => {
  const a = assess([job('insights', 'stale', 80 * H, 200 * H)])
  const { recover, skipped } = planJobRecovery({
    assessment: a, recoverable: ['insights'], now: NOW, maxPerCycle: 0,
  })
  assert.equal(recover.length, 0)
  assert.equal(skipped[0].reason, 'cap')
})

// ── Clock fail-safe ─────────────────────────────────────────────────────────────────

test('fail-safe: an unparseable clock recovers nothing and surfaces no-clock', () => {
  const a = assess([job('insights', 'overdue', 4 * H, 40 * H)])
  const { recover, skipped } = planJobRecovery({
    assessment: a, recoverable: ['insights'], now: 'not-a-date',
  })
  assert.equal(recover.length, 0)
  assert.equal(skipped.length, 1)
  assert.equal(skipped[0].reason, 'no-clock')
})

// ── Purity & robustness ─────────────────────────────────────────────────────────────

test('purity: never mutates the cooldown ledger', () => {
  const a = assess([job('insights', 'overdue', 4 * H, 40 * H)])
  const ledger = { insights: NOW - 3 * H }
  const before = JSON.stringify(ledger)
  planJobRecovery({ assessment: a, recoverable: ['insights'], now: NOW, cooldownLedger: ledger })
  assert.equal(JSON.stringify(ledger), before)
})

test('robust: empty or malformed assessment yields an empty plan, never throws', () => {
  for (const bad of [undefined, null, {}, { jobs: null }, { jobs: 'x' }, { jobs: [null, 1, {}] }]) {
    const { recover, skipped } = planJobRecovery({ assessment: bad, recoverable: ['insights'], now: NOW })
    assert.equal(recover.length, 0)
    assert.equal(skipped.length, 0)
  }
})

// ── Core predicate + exported defaults ──────────────────────────────────────────────

test('isRecoverable: allow-list ∩ not-deny-list', () => {
  assert.equal(isRecoverable('insights', ['insights']), true)
  assert.equal(isRecoverable('insights', []), false)
  assert.equal(isRecoverable('insights', ['sync']), false)
  assert.equal(isRecoverable('watchdog', ['watchdog']), false)  // hard deny
  assert.equal(isRecoverable('digest', ['digest']), false)      // hard deny
  assert.equal(isRecoverable(null, ['insights']), false)
  assert.equal(isRecoverable('insights', null), false)
})

test('exports safe, expected defaults', () => {
  assert.equal(DEFAULT_COOLDOWN_MS, 2 * 60 * 60 * 1000)
  assert.equal(DEFAULT_MAX_PER_CYCLE, 2)
  assert.deepEqual(DEFAULT_RECOVER_STATUSES, ['overdue', 'stale'])
  assert.deepEqual(NEVER_RECOVERABLE, ['watchdog', 'digest'])
})

// ── End-to-end with the real grader ─────────────────────────────────────────────────

test('integrates with assessOps: a genuinely overdue insights sweep plans a recovery', () => {
  // insights cadence 24h, grace 1.5 → overdue band (36h, 72h]. 40h ago = overdue.
  const runs = [
    { id: 1, job: 'insights', status: 'success', ran_at: new Date(NOW - 40 * H).toISOString(), detail: null },
  ]
  const assessment = assessOps({ runs, now: new Date(NOW).toISOString() })
  assert.equal(assessment.status, 'overdue')
  const ins = assessment.jobs.find((j) => j.job === 'insights')
  assert.equal(ins.status, 'overdue')

  const { recover } = planJobRecovery({
    assessment, recoverable: ['insights'], now: NOW, cooldownLedger: {},
  })
  assert.equal(recover.length, 1)
  assert.equal(recover[0].job, 'insights')
  assert.ok(recover[0].overdueByMs > 0)
})

test('integrates with assessOps: a healthy (live) engine plans no recovery', () => {
  const runs = [
    { id: 1, job: 'sync', status: 'success', ran_at: new Date(NOW - 1 * H).toISOString(), detail: null },
    { id: 2, job: 'watchdog', status: 'success', ran_at: new Date(NOW - 5 * 60 * 1000).toISOString(), detail: '{"healed":0}' },
    { id: 3, job: 'insights', status: 'success', ran_at: new Date(NOW - 2 * H).toISOString(), detail: null },
  ]
  const assessment = assessOps({ runs, now: new Date(NOW).toISOString() })
  const { recover } = planJobRecovery({ assessment, recoverable: ['insights'], now: NOW })
  assert.equal(recover.length, 0)
})
