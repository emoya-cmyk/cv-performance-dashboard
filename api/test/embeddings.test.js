// ============================================================
// test/embeddings.test.js — the zero-dependency local embedder
// (lib/embeddings.localEmbed) that makes semantic recall work out of the box.
// ============================================================
'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const { localEmbed, EMBED_DIM } = require('../lib/embeddings')
const { cosine, semanticRecall } = require('../lib/memorySemantic')

const os = require('os'); const path = require('path'); const fs = require('fs')
delete process.env.DATABASE_URL
const DB_PATH = path.join(os.tmpdir(), `embed_${process.pid}.db`)
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
process.env.SQLITE_PATH = DB_PATH
const db = require('../db')
const { remember } = require('../lib/memory')
const { after } = require('node:test')
after(() => { for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} } })

test('localEmbed is deterministic and fixed-length', () => {
  const a = localEmbed('revenue is up')
  const b = localEmbed('revenue is up')
  assert.equal(a.length, EMBED_DIM)
  assert.deepEqual(a, b)
})

test('overlapping text is more similar than disjoint text', () => {
  const q  = localEmbed('revenue grew strongly this week')
  const near = localEmbed('revenue grew this week')
  const far  = localEmbed('spend on facebook calls dropped')
  assert.ok(cosine(q, near) > cosine(q, far))
})

test('semanticRecall works out of the box with the local embedder', async () => {
  await db.migrate()
  const AG = { role: 'agency' }
  await remember(AG, { client_id: 'e1', kind: 'note', content: 'revenue grew strongly', source: 'fact' })
  await remember(AG, { client_id: 'e1', kind: 'note', content: 'facebook spend dropped', source: 'fact' })
  const out = await semanticRecall(AG, 'how did revenue grow', { embed: localEmbed, clientId: 'e1', k: 2 })
  assert.equal(out[0].content, 'revenue grew strongly')
})
