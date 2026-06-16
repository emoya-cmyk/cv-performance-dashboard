'use strict'

// Integration tests for lib/makeRemediationSweeps against a real (isolated)
// SQLite database — the Tier 1 digest dedup (FR-8), dead-letter retention
// (FR-4), and Wilson-score confidence application + freeze (FR-9).

const os   = require('os')
const path = require('path')
const fs   = require('fs')
const crypto = require('crypto')
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')

// Pin an isolated SQLite file BEFORE requiring db (db.js picks SQLite when
// DATABASE_URL is unset and honors SQLITE_PATH).
delete process.env.DATABASE_URL
const DB_PATH = path.join(os.tmpdir(), `make_sweeps_${process.pid}.db`)
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
process.env.SQLITE_PATH = DB_PATH

const db = require('../db')
const { runTier1Digest, runDeadLetterRetention, recordConfidence } = require('../lib/makeRemediationSweeps')

const logId = () => crypto.randomUUID()

async function insertLog({ tier, scenario = 's1', tenant = 't1', dead = 0, notified = 0 }) {
  const id = logId()
  await db.query(
    `INSERT INTO make_remediation_log
       (id, scenario_id, execution_id, tenant_id, vendor, failure_tier,
        remediation_outcome, dead_lettered, batched_notified)
     VALUES ($1,$2,$3,$4,'GHL',$5,'escalated',$6,$7)`,
    [id, scenario, 'x-' + id, tenant, tier, dead, notified]
  )
  return id
}

before(async () => { await db.migrate() })
after(() => { for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} } })

// ── Tier 1 digest (FR-8) ──────────────────────────────────────────────────────

test('runTier1Digest summarises unnotified Tier 1 events exactly once', async () => {
  await insertLog({ tier: 1, tenant: 't1', dead: 1 })
  await insertLog({ tier: 1, tenant: 't2', dead: 0 })
  await insertLog({ tier: 0 }) // Tier 0 must be ignored

  const sent = []
  const sendAlert = async (a) => { sent.push(a) }

  const first = await runTier1Digest({ query: db.query, sendAlert })
  assert.equal(first.events, 2)
  assert.equal(first.sent, true)
  assert.equal(sent.length, 1)
  assert.match(sent[0].body, /Auto-handled: 2 failures/)
  assert.match(sent[0].body, /Dead-lettered: 1 payloads/)

  // Second run: everything already notified → no-op, no Slack.
  const second = await runTier1Digest({ query: db.query, sendAlert })
  assert.equal(second.events, 0)
  assert.equal(second.sent, false)
  assert.equal(sent.length, 1)
})

// ── Dead-letter retention (FR-4) ──────────────────────────────────────────────

test('runDeadLetterRetention prunes only resolved items past the window', async () => {
  const mk = async (status, resolvedAt) => {
    const id = logId()
    await db.query(
      `INSERT INTO make_dead_letter (id, tenant_id, vendor, status, resolved_at)
       VALUES ($1,'t1','GHL',$2,$3)`,
      [id, status, resolvedAt]
    )
    return id
  }
  const old = new Date(Date.now() - 40 * 86400000).toISOString()
  const recent = new Date(Date.now() - 5 * 86400000).toISOString()

  const oldResolved    = await mk('resolved', old)
  const recentResolved = await mk('resolved', recent)
  const oldOpen        = await mk('open', null)

  const r = await runDeadLetterRetention({ query: db.query })
  assert.equal(r.pruned, 1) // only the old *resolved* one

  const survivors = (await db.query('SELECT id FROM make_dead_letter')).rows.map(x => x.id)
  assert.ok(!survivors.includes(oldResolved), 'old resolved pruned')
  assert.ok(survivors.includes(recentResolved), 'recent resolved kept')
  assert.ok(survivors.includes(oldOpen), 'open item never pruned')
})

// ── Confidence store (FR-9) ────────────────────────────────────────────────────

test('recordConfidence applies deltas and freezes on Tier 3', async () => {
  const sc = 'scn-conf'
  const a = await recordConfidence({ query: db.query, scenarioId: sc, outcomeKey: 'tier1_remapped_verified' })
  assert.equal(a.confidence, 0.55) // 0.5 + 0.05

  const b = await recordConfidence({ query: db.query, scenarioId: sc, outcomeKey: 'tier1_dead_lettered' })
  assert.equal(Number(b.confidence.toFixed(2)), 0.45) // 0.55 - 0.10

  // Escalation freezes the scenario...
  const frozen = await recordConfidence({ query: db.query, scenarioId: sc, outcomeKey: 'tier3_escalated' })
  assert.equal(frozen.frozen, true)

  // ...and a later negative outcome must no longer move it.
  const held = await recordConfidence({ query: db.query, scenarioId: sc, outcomeKey: 'tier2_refresh_failed' })
  assert.equal(Number(held.confidence.toFixed(2)), 0.45)
  assert.equal(held.frozen, true)
})

test('recordConfidence is a safe no-op without a scenario id', async () => {
  assert.equal(await recordConfidence({ query: db.query, scenarioId: '', outcomeKey: 'tier0_resolved' }), null)
})
