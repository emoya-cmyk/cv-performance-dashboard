// ============================================================
// test/embeddingsProvider.test.js — the env-gated pluggable embedder
// (lib/embeddings.makeEmbedder / voyageEmbed). Verifies:
//   • default (no env) is the deterministic local embedder, byte-identical
//   • provider selection picks Voyage only when key + provider are set
//   • the real provider is MOCKED (no live network) and, on any failure,
//     falls back to the local embedder
//   • a dimension mismatch between embedders is never silently compared
// ============================================================
'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const Module = require('module')

const { localEmbed, makeEmbedder, voyageEmbed, EMBED_DIM } = require('../lib/embeddings')
const { cosine } = require('../lib/memorySemantic')

// ── helper: run a fn with axios.post stubbed, no real network ────────────────
function withMockedAxios(post, fn) {
  const orig = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'axios') return { post }
    return orig.apply(this, arguments)
  }
  // Bust the cached lib/embeddings so its `require('axios')` re-resolves to the mock.
  const embPath = require.resolve('../lib/embeddings')
  const cached = require.cache[embPath]
  delete require.cache[embPath]
  try {
    const fresh = require('../lib/embeddings')
    return fn(fresh)
  } finally {
    Module._load = orig
    if (cached) require.cache[embPath] = cached
    else delete require.cache[require.resolve('../lib/embeddings')]
  }
}

test('default makeEmbedder() is the deterministic local embedder (no env set)', async () => {
  delete process.env.EMBEDDINGS_PROVIDER
  delete process.env.VOYAGE_API_KEY
  const { embed, name } = makeEmbedder()
  assert.equal(name, 'local')
  const a = await embed('revenue is up')
  assert.equal(a.length, EMBED_DIM)
  assert.deepEqual(a, localEmbed('revenue is up')) // byte-identical to today
})

test('an unknown provider falls back to local', () => {
  const { name } = makeEmbedder({ provider: 'pinecone-9000', voyageApiKey: 'x' })
  assert.equal(name, 'local')
})

test('voyage requested but NO key → local (behaviour unchanged without a key)', () => {
  const { embed, name } = makeEmbedder({ provider: 'voyage', voyageApiKey: '' })
  assert.equal(name, 'local')
  assert.equal(embed, localEmbed)
})

test('voyage requested WITH a key → voyage embedder selected', () => {
  const { name } = makeEmbedder({ provider: 'voyage', voyageApiKey: 'vk-test' })
  assert.ok(name.startsWith('voyage:'))
})

test('voyageEmbed returns the mocked vector (no live network)', async () => {
  const vec = new Array(1024).fill(0).map((_, i) => (i % 3) / 7)
  await withMockedAxios(
    async () => ({ data: { data: [{ embedding: vec }] } }),
    async (emb) => {
      const out = await emb.voyageEmbed('hello', { apiKey: 'vk-test', model: 'voyage-3.5-lite' })
      assert.deepEqual(out, vec)
      assert.equal(out.length, 1024) // a real model dim, distinct from local's 64
    },
  )
})

test('voyageEmbed returns null on transport error (never throws into recall)', async () => {
  await withMockedAxios(
    async () => { throw new Error('ETIMEDOUT') },
    async (emb) => {
      const out = await emb.voyageEmbed('hello', { apiKey: 'vk-test' })
      assert.equal(out, null)
    },
  )
})

test('voyageEmbed returns null when the response shape is bad', async () => {
  await withMockedAxios(
    async () => ({ data: { data: [] } }),
    async (emb) => {
      assert.equal(await emb.voyageEmbed('hi', { apiKey: 'vk-test' }), null)
    },
  )
})

test('voyageEmbed returns null with no key (no call attempted)', async () => {
  let called = false
  await withMockedAxios(
    async () => { called = true; return { data: {} } },
    async (emb) => {
      assert.equal(await emb.voyageEmbed('hi', { apiKey: '' }), null)
      assert.equal(called, false)
    },
  )
})

test('voyage embedder falls back to local for THAT call when the API fails', async () => {
  await withMockedAxios(
    async () => { throw new Error('boom') },
    async (emb) => {
      const { embed } = emb.makeEmbedder({ provider: 'voyage', voyageApiKey: 'vk-test' })
      const out = await embed('revenue is up')
      // failure → local vector, so recall keeps working at local quality
      assert.deepEqual(out, localEmbed('revenue is up'))
    },
  )
})

test('dimension guard: mismatched-length vectors are never silently compared', () => {
  // local (64-dim) vs a real-model-sized (1024-dim) vector → cosine guards to 0,
  // so a provider switch can never silently rank against stale-dimension vectors.
  const small = localEmbed('revenue is up')
  const big = new Array(1024).fill(1)
  assert.equal(small.length, 64)
  assert.notEqual(small.length, big.length)
  assert.equal(cosine(small, big), 0)
})
