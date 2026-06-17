// ============================================================
// test/memoryRecall.benchmark.test.js — regression guard for the semantic
// (vector) memory recall quality of the FREE local embedder
// (lib/embeddings.localEmbed) driving lib/memorySemantic.semanticRecall.
//
// Backed by bench/memoryRecall.bench.js: a fixed, hand-labeled fixture of memory
// items + queries, run on an isolated temp SQLite DB. Deterministic and offline.
//
// HONEST MEASURED BASELINE (node bench/memoryRecall.bench.js, deterministic):
//   embedder (semantic): P@3 46.7%  P@5 32.0%  R@3 60.0%  R@5 66.7%
//   keyword baseline:    P@3 53.3%  P@5 34.0%  R@3 70.0%  R@5 73.3%
//
// FINDING: the local hashing bag-of-words embedder does NOT beat a naive keyword
// baseline on this fixture — it slightly trails it (R@5 66.7% vs 73.3%). That is
// expected: localEmbed is FNV-hashed bag-of-words with no synonym generalization,
// so it carries the same lexical signal as substring matching plus hash-collision
// noise. The floors below are set HONESTLY a bit under the measured embedder
// values so this is a real regression guard (catches a drop), not a tautology,
// and not fudged upward to imply quality the embedder does not have. For true
// semantic lift, inject a real embedder via semanticRecall's `embed` seam
// (see lib/embeddings.js header note: Voyage/OpenAI/sentence-transformers).
// ============================================================
'use strict'

const { test } = require('node:test')
const assert   = require('node:assert/strict')

const { runBenchmark } = require('../bench/memoryRecall.bench')

// Floors derived from the measured embedder numbers, set a notch below so a real
// regression (worse recall) trips the guard while normal determinism passes.
const FLOOR = {
  recallAt5:    0.55, // measured 0.667
  recallAt3:    0.50, // measured 0.600
  precisionAt3: 0.38, // measured 0.467
}

test('semantic recall benchmark: embedder recall stays above the honest floor', async () => {
  const res = await runBenchmark()

  // eslint-disable-next-line no-console
  console.log('[memoryRecall.benchmark] embedder=%o keyword=%o',
    res.embedder, res.keyword)

  assert.ok(
    res.embedder.recallAt5 >= FLOOR.recallAt5,
    `embedder recall@5 ${res.embedder.recallAt5.toFixed(3)} fell below floor ${FLOOR.recallAt5} — semantic recall regressed`,
  )
  assert.ok(
    res.embedder.recallAt3 >= FLOOR.recallAt3,
    `embedder recall@3 ${res.embedder.recallAt3.toFixed(3)} fell below floor ${FLOOR.recallAt3} — semantic recall regressed`,
  )
  assert.ok(
    res.embedder.precisionAt3 >= FLOOR.precisionAt3,
    `embedder precision@3 ${res.embedder.precisionAt3.toFixed(3)} fell below floor ${FLOOR.precisionAt3} — semantic recall regressed`,
  )

  // Sanity: metrics are well-formed probabilities.
  for (const m of [res.embedder, res.keyword]) {
    for (const v of Object.values(m)) {
      assert.ok(v >= 0 && v <= 1, `metric ${v} out of [0,1]`)
    }
  }
})
