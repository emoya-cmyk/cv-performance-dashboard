// ============================================================
// test/memorySemantic.test.js — Memory OS Phase 8 semantic recall
// (lib/memorySemantic). Embedding-ranked recall with a pluggable embedder;
// keyword fallback when none is supplied. Uses a deterministic fake embedder
// (bag-of-words over a tiny vocab), so no provider is needed to test it.
//
// Runs on an isolated temp SQLite DB. Run with:  npm test   (from api/)
// ============================================================
'use strict'

const os     = require('os')
const path   = require('path')
const fs     = require('fs')
const { test, after } = require('node:test')
const assert = require('node:assert/strict')

delete process.env.DATABASE_URL
const DB_PATH = path.join(os.tmpdir(), `memory_sem_${process.pid}.db`)
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
process.env.SQLITE_PATH = DB_PATH

const db = require('../db')
const { remember } = require('../lib/memory')
const { semanticRecall, cosine } = require('../lib/memorySemantic')

after(() => { for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} } })

let migrated = false
async function ready() { if (!migrated) { await db.migrate(); migrated = true } }

// Deterministic fake embedder: count occurrences of each vocab word → a vector.
const VOCAB = ['revenue', 'leads', 'spend', 'roas', 'calls', 'up', 'down']
const embed = (text) => {
  const t = String(text).toLowerCase()
  return VOCAB.map((w) => (t.match(new RegExp(`\\b${w}\\b`, 'g')) || []).length)
}

const AGENCY = { role: 'agency' }

test('cosine is 1 for identical vectors, 0 for orthogonal/degenerate', () => {
  assert.ok(Math.abs(cosine([1, 2, 3], [1, 2, 3]) - 1) < 1e-9)
  assert.equal(cosine([1, 0], [0, 1]), 0)
  assert.equal(cosine([0, 0], [1, 1]), 0)
  assert.equal(cosine([1, 2], [1, 2, 3]), 0) // length mismatch
})

test('semanticRecall ranks the semantically-closest memory first', async () => {
  await ready()
  await remember(AGENCY, { client_id: 's1', kind: 'note', content: 'revenue is up this week', source: 'fact' })
  await remember(AGENCY, { client_id: 's1', kind: 'note', content: 'spend on calls increased', source: 'fact' })
  await remember(AGENCY, { client_id: 's1', kind: 'note', content: 'roas held steady', source: 'fact' })

  const out = await semanticRecall(AGENCY, 'how is revenue trending up', { embed, clientId: 's1', k: 3 })
  assert.equal(out[0].content, 'revenue is up this week')
  assert.ok(out[0].similarity > 0)
})

test('without an embedder it falls back to a keyword filter (no provider needed)', async () => {
  await ready()
  await remember(AGENCY, { client_id: 's2', kind: 'note', content: 'leads from google ads', source: 'fact' })
  await remember(AGENCY, { client_id: 's2', kind: 'note', content: 'spend summary', source: 'fact' })

  const out = await semanticRecall(AGENCY, 'leads', { clientId: 's2', k: 5 })
  assert.equal(out.length, 1)
  assert.equal(out[0].content, 'leads from google ads')
})

test('a client scope confines semantic recall to its own tenant', async () => {
  await ready()
  await remember(AGENCY, { client_id: 'tenantX', kind: 'note', content: 'revenue up for X', source: 'fact' })
  await remember(AGENCY, { client_id: 'tenantY', kind: 'note', content: 'revenue up for Y', source: 'fact' })
  const out = await semanticRecall({ role: 'client', clientId: 'tenantX' }, 'revenue', { embed, k: 5 })
  assert.ok(out.every((m) => m.client_id === 'tenantX'))
  assert.ok(!out.some((m) => /for Y/.test(m.content)))
})
