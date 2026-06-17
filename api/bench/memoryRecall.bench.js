'use strict'

// ── Memory OS — semantic recall benchmark ─────────────────────────────────────
//
// Quantifies the recall quality of the FREE local embedder (lib/embeddings.js)
// driving semantic memory search (lib/memorySemantic.js → semanticRecall), and
// contrasts it against a naive keyword/substring baseline so we can see whether
// the embedder actually adds value.
//
// Fully deterministic and offline:
//   • localEmbed is a dependency-free hashing bag-of-words (no network, no key).
//   • The fixture below is a fixed, hand-labeled set of memory items + queries.
//   • It runs on an isolated temp SQLite DB seeded only with the fixture.
//
// Run it:   node api/bench/memoryRecall.bench.js
// It prints mean precision@k / recall@k (k=3,5) for the embedder and for the
// keyword baseline. The same runBenchmark() backs the regression-guard test
// (test/memoryRecall.benchmark.test.js).

const os   = require('os')
const path = require('path')
const fs   = require('fs')

const { localEmbed } = require('../lib/embeddings')

// ── Fixture ───────────────────────────────────────────────────────────────────
// Realistic short performance/ops memory notes for this dashboard's domain.
// Each item has a stable id and content. The queries below reference these ids
// as ground truth — the hand-labeled set of items genuinely relevant to the
// query's intent (not merely sharing a keyword).
const ITEMS = [
  { id: 1,  content: 'Revenue is up 18% week over week, strongest month to date' },
  { id: 2,  content: 'Monthly recurring revenue climbed after the pricing change' },
  { id: 3,  content: 'Total sales income grew sharply versus last quarter' },
  { id: 4,  content: 'Lead volume from Google Ads jumped 40% this week' },
  { id: 5,  content: 'Inbound leads from paid search are trending higher' },
  { id: 6,  content: 'New contact form submissions doubled after the landing page test' },
  { id: 7,  content: 'Ad spend on Facebook campaigns increased over budget' },
  { id: 8,  content: 'Marketing budget for paid media was raised this month' },
  { id: 9,  content: 'Cost per acquisition rose because spend outpaced conversions' },
  { id: 10, content: 'ROAS held steady at 3.2 across all paid channels' },
  { id: 11, content: 'Return on ad spend improved after pausing low performers' },
  { id: 12, content: 'Phone calls from the call tracking number dropped on weekends' },
  { id: 13, content: 'Booked appointments fell after the intake form broke' },
  { id: 14, content: 'Website page load time regressed to 4 seconds on mobile' },
  { id: 15, content: 'Site speed degraded after the latest deploy, mobile worst hit' },
  { id: 16, content: 'Email open rate declined for the weekly newsletter' },
  { id: 17, content: 'Newsletter click through rate ticked up after subject line test' },
  { id: 18, content: 'Organic search traffic from Google grew steadily this quarter' },
  { id: 19, content: 'SEO rankings for core keywords improved into the top three' },
  { id: 20, content: 'Conversion rate on the checkout page slipped after the redesign' },
  { id: 21, content: 'Customer churn increased among annual plan subscribers' },
  { id: 22, content: 'Refund requests spiked following the shipping delay' },
  { id: 23, content: 'Average order value rose as customers added more items' },
  { id: 24, content: 'Cart abandonment climbed during the holiday rush' },
]

// Queries with hand-labeled ground-truth relevant item ids. Relevance is by
// intent/topic, deliberately phrased with words that often do NOT literally
// appear in the items, so this exercises semantics, not exact-string matching.
const QUERIES = [
  { q: 'how is revenue trending',                relevant: [1, 2, 3] },
  { q: 'are we getting more leads',              relevant: [4, 5, 6] },
  { q: 'what is happening with ad spend budget', relevant: [7, 8, 9] },
  { q: 'return on advertising efficiency',       relevant: [10, 11] },
  { q: 'phone calls and booked appointments',    relevant: [12, 13] },
  { q: 'website performance and page speed',     relevant: [14, 15] },
  { q: 'email newsletter engagement',            relevant: [16, 17] },
  { q: 'organic search and seo visibility',      relevant: [18, 19] },
  { q: 'checkout conversion and order value',    relevant: [20, 23, 24] },
  { q: 'customer churn and refunds',             relevant: [21, 22] },
]

// ── Metrics ───────────────────────────────────────────────────────────────────
// precision@k = (# relevant in top-k) / k
// recall@k    = (# relevant in top-k) / (# relevant total)
function precisionAtK(rankedIds, relevant, k) {
  const top = rankedIds.slice(0, k)
  const rel = new Set(relevant)
  const hits = top.filter((id) => rel.has(id)).length
  return k > 0 ? hits / k : 0
}

function recallAtK(rankedIds, relevant, k) {
  const top = rankedIds.slice(0, k)
  const rel = new Set(relevant)
  const hits = top.filter((id) => rel.has(id)).length
  return relevant.length > 0 ? hits / relevant.length : 0
}

function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0 }

// ── Rankers ───────────────────────────────────────────────────────────────────
// Embedder ranker: real semantic search via semanticRecall + localEmbed over
// the seeded memory rows. We request k=24 (all items) so we can compute @3/@5
// over the same single ranking. blend=1 isolates the embedder's similarity
// (no decay mixing) — all fixture rows are written at the same instant so decay
// is uniform anyway, but this keeps the measurement purely about embedding recall.
async function embedderRanking(semanticRecall, scope, queryText) {
  const out = await semanticRecall(scope, queryText, {
    embed: localEmbed,
    k: ITEMS.length,
    candidatePool: ITEMS.length,
    blend: 1,
  })
  return out.map((m) => m.id)
}

// Keyword baseline: rank by count of query word-tokens that appear as substrings
// in the item content (then by item id for stable ordering). This is the naive
// "what you'd do without embeddings" approach.
function keywordRanking(queryText) {
  const STOP = new Set(['how', 'is', 'are', 'we', 'the', 'and', 'with', 'what',
    'of', 'to', 'on', 'in', 'a', 'an', 'for', 'getting', 'happening', 'more', 'into'])
  const qTokens = String(queryText).toLowerCase().match(/[a-z0-9]+/g) || []
  const terms = qTokens.filter((t) => !STOP.has(t))
  return ITEMS
    .map((it) => {
      const c = it.content.toLowerCase()
      const score = terms.reduce((n, t) => n + (c.includes(t) ? 1 : 0), 0)
      return { id: it.id, score }
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.id - b.id)
    .map((r) => r.id)
}

// ── Runner ────────────────────────────────────────────────────────────────────
// Seeds an isolated temp SQLite DB with the fixture, runs both rankers across
// every query, and aggregates the metrics. Returns a plain results object so the
// test can assert on it and the script can print it. Self-contained: it sets up
// its own DB and tears it down.
async function runBenchmark() {
  delete process.env.DATABASE_URL
  const DB_PATH = path.join(os.tmpdir(), `memory_recall_bench_${process.pid}_${Date.now()}.db`)
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} }
  process.env.SQLITE_PATH = DB_PATH

  // Require AFTER pinning SQLITE_PATH so db.js binds to the temp file.
  const db = require('../db')
  const { remember } = require('../lib/memory')
  const { semanticRecall } = require('../lib/memorySemantic')

  const cleanup = () => { for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext) } catch {} } }

  try {
    await db.migrate()
    const scope = { role: 'agency' }
    // Seed the fixture as agency-wide memories. A fixed `now` keeps decay uniform.
    const now = '2026-06-17T00:00:00.000Z'
    for (const it of ITEMS) {
      await remember(scope, { kind: 'note', content: it.content, source: 'fact' })
    }

    const ks = [3, 5]
    const per = { embedder: { p3: [], p5: [], r3: [], r5: [] },
                  keyword:  { p3: [], p5: [], r3: [], r5: [] } }
    const queryDetail = []

    for (const { q, relevant } of QUERIES) {
      const eRanked = await embedderRanking(semanticRecall, scope, q)
      const kRanked = keywordRanking(q)
      per.embedder.p3.push(precisionAtK(eRanked, relevant, 3))
      per.embedder.p5.push(precisionAtK(eRanked, relevant, 5))
      per.embedder.r3.push(recallAtK(eRanked, relevant, 3))
      per.embedder.r5.push(recallAtK(eRanked, relevant, 5))
      per.keyword.p3.push(precisionAtK(kRanked, relevant, 3))
      per.keyword.p5.push(precisionAtK(kRanked, relevant, 5))
      per.keyword.r3.push(recallAtK(kRanked, relevant, 3))
      per.keyword.r5.push(recallAtK(kRanked, relevant, 5))
      queryDetail.push({
        q,
        relevant,
        embedderTop5: eRanked.slice(0, 5),
        keywordTop5: kRanked.slice(0, 5),
      })
    }

    return {
      ks,
      nItems: ITEMS.length,
      nQueries: QUERIES.length,
      embedder: {
        precisionAt3: mean(per.embedder.p3),
        precisionAt5: mean(per.embedder.p5),
        recallAt3:    mean(per.embedder.r3),
        recallAt5:    mean(per.embedder.r5),
      },
      keyword: {
        precisionAt3: mean(per.keyword.p3),
        precisionAt5: mean(per.keyword.p5),
        recallAt3:    mean(per.keyword.r3),
        recallAt5:    mean(per.keyword.r5),
      },
      queryDetail,
    }
  } finally {
    cleanup()
  }
}

function fmt(n) { return (n * 100).toFixed(1) + '%' }

function printResults(res) {
  /* eslint-disable no-console */
  console.log('\n── Memory OS semantic recall benchmark ──────────────────────────')
  console.log(`fixture: ${res.nItems} memory items, ${res.nQueries} labeled queries`)
  console.log('embedder: lib/embeddings.localEmbed (free, local, deterministic)\n')
  const row = (label, m) =>
    `${label.padEnd(20)} P@3 ${fmt(m.precisionAt3).padStart(6)}  P@5 ${fmt(m.precisionAt5).padStart(6)}  ` +
    `R@3 ${fmt(m.recallAt3).padStart(6)}  R@5 ${fmt(m.recallAt5).padStart(6)}`
  console.log(row('embedder (semantic)', res.embedder))
  console.log(row('keyword baseline', res.keyword))
  console.log('\nrecall@5 lift (embedder - keyword): ' +
    fmt(res.embedder.recallAt5 - res.keyword.recallAt5))
  console.log('─────────────────────────────────────────────────────────────────\n')
  /* eslint-enable no-console */
}

module.exports = {
  ITEMS, QUERIES, runBenchmark, printResults,
  precisionAtK, recallAtK, embedderRanking, keywordRanking,
}

// Runnable as a script.
if (require.main === module) {
  runBenchmark()
    .then((res) => { printResults(res); process.exit(0) })
    .catch((err) => { console.error(err); process.exit(1) })
}
