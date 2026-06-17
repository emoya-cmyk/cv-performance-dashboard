// ============================================================
// test/contribution.test.js — intel-v6 (5a): the PURE by-client decomposition.
//
// contributionBreakdown(metric, from, to, opts) splits an additive metric's
// period-over-period agency delta into per-client contributions: Δtotal = Σ
// Δclient, exactly. No DB, no LLM, no clock — so every assertion below is exact.
//
// What's proven here:
//   • EXACTNESS — the signed per-client shares sum to exactly 1, and the named
//     deltas + others + unattributed reconcile to the true Δtotal;
//   • RANKING — contributors are ordered by |move|, ties broken by label;
//   • the LEAD is the most-ALIGNED mover (the client most responsible for the
//     change), which need NOT be the largest mover — a big opposite swing can
//     outrank it by magnitude while a smaller aligned client actually drove it;
//   • a client that moved AGAINST the total carries a negative share (a cushion);
//   • RATIOS (roas/cpl/close_rate) are not additive → null;
//   • RECONCILIATION — authoritative totals larger than the supplied rows surface
//     an explicit `unattributed` remainder (no silent truncation under a LIMIT cap);
//   • the client UNION is taken — a new client rises from 0, a churned one falls to 0;
//   • a flat total and a 0 baseline are handled honestly (null / null-pct);
//   • narrateContribution is GROUNDED — every number it emits comes from the result;
//   • malformed / empty / garbage input degrades safely and never throws.
// ============================================================
'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

// contribution.js requires NOTHING (no ../db, no ../lib/ask) — it is a closed pure
// module — so unlike the other lib tests there is no SQLite path to isolate here.
const {
  contributionBreakdown,
  narrateContribution,
  isAdditive,
  additiveMetrics,
  ADDITIVE,
} = require('..')

// Σ of every part's signed share (named contributors + others + unattributed).
// The invariant: this equals exactly 1 over any real move.
function shareSum(res) {
  let s = res.contributors.reduce((a, c) => a + c.share, 0)
  if (res.others) s += res.others.share
  if (res.unattributed) s += res.unattributed.share
  return s
}
const APPROX = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`)

// ── the canonical exact decomposition ─────────────────────────────────────────
test('an additive metric decomposes exactly: signed shares sum to 1, ranked by |move|', () => {
  const from = [{ bucket: 'Acme', value: 100 }, { bucket: 'Globex', value: 50 }, { bucket: 'Initech', value: 30 }]
  const to   = [{ bucket: 'Acme', value: 160 }, { bucket: 'Globex', value: 60 }, { bucket: 'Initech', value: 20 }]
  const res = contributionBreakdown('revenue', from, to)

  assert.equal(res.direction, 'up')
  assert.equal(res.total_from, 180)
  assert.equal(res.total_to, 240)
  assert.equal(res.total_delta, 60)             // 240 − 180
  assert.equal(res.pct, 33.3)                   // 100·(240/180 − 1)

  // Δtotal = Σ Δclient, exactly.
  const sumDelta = res.contributors.reduce((a, c) => a + c.delta, 0)
  assert.equal(sumDelta, res.total_delta)
  APPROX(shareSum(res), 1)

  // ranked by |delta|: Acme(+60), then Globex(+10) before Initech(−10) by |.|=10 tie → label asc.
  assert.deepEqual(res.contributors.map((c) => c.key), ['Acme', 'Globex', 'Initech'])
  assert.equal(res.contributors[0].share, 1)            // 60/60
  assert.equal(res.contributors[0].share_pct, 100)
  assert.equal(res.contributors[2].delta, -10)          // Initech fell
  assert.ok(res.contributors[2].share < 0, 'an opposite mover carries a NEGATIVE share')

  // the lead is the most-aligned mover — here also the biggest.
  assert.equal(res.lead.key, 'Acme')
  assert.equal(res.others, null)
  assert.equal(res.unattributed, null)
})

// ── the lead is the most ALIGNED mover, not necessarily the biggest ───────────
test('lead = the client most responsible for the move, even when a bigger swing opposes it', () => {
  // total rose just +10, but A crashed −60 (the largest |move|) while C rose +40.
  const from = [{ key: 'A', value: 100 }, { key: 'B', value: 5 }, { key: 'C', value: 5 }]
  const to   = [{ key: 'A', value: 40 },  { key: 'B', value: 35 }, { key: 'C', value: 45 }]
  const res = contributionBreakdown('jobs', from, to)

  assert.equal(res.total_delta, 10)                     // 120 − 110
  assert.equal(res.pct, 9.1)
  // #1 by magnitude is the cushion A (−60); the lead is C (+40, most aligned with the +move).
  assert.equal(res.contributors[0].key, 'A')
  assert.ok(res.contributors[0].share < 0, 'the biggest mover here is a cushion')
  assert.equal(res.lead.key, 'C')
  assert.ok(res.lead.share > 0, 'the lead moved WITH the total')
  APPROX(shareSum(res), 1)
})

// ── the long tail folds into `others`, and it still reconciles ────────────────
test('beyond the limit, contributors fold into `others` and the shares still sum to 1', () => {
  const from = ['A', 'B', 'C', 'D', 'E', 'F'].map((k) => ({ key: k, value: 10 }))
  const to   = [['A', 40], ['B', 30], ['C', 20], ['D', 12], ['E', 11], ['F', 10]].map(([k, v]) => ({ key: k, value: v }))
  const res = contributionBreakdown('leads', from, to, { limit: 3 })

  assert.equal(res.total_delta, 63)                     // 123 − 60
  assert.equal(res.contributors.length, 3)              // A(+30), B(+20), C(+10)
  assert.deepEqual(res.contributors.map((c) => c.key), ['A', 'B', 'C'])
  assert.ok(res.others, 'a tail of 3 folds into others')
  assert.equal(res.others.count, 3)                     // D, E, F
  assert.equal(res.others.delta, 3)                     // (12+11+10) − (10+10+10)
  // named deltas + others delta = total delta, exactly.
  assert.equal(res.contributors.reduce((a, c) => a + c.delta, 0) + res.others.delta, res.total_delta)
  APPROX(shareSum(res), 1)
  assert.equal(res.lead.key, 'A')
})

// ── authoritative totals > supplied rows → an explicit `unattributed` remainder ─
test('a LIMIT-capped client query reconciles via an `unattributed` remainder — no silent truncation', () => {
  // Only the top two clients were fetched, but the agency totals are authoritative.
  const from = [{ bucket: 'A', value: 100 }, { bucket: 'B', value: 80 }]   // Σ 180
  const to   = [{ bucket: 'A', value: 160 }, { bucket: 'B', value: 90 }]   // Σ 250
  const res = contributionBreakdown('revenue', from, to, { totalFrom: 200, totalTo: 300 })

  assert.equal(res.total_from, 200)                     // authoritative, not the summed 180
  assert.equal(res.total_to, 300)
  assert.equal(res.total_delta, 100)
  assert.ok(res.unattributed, 'the gap to the true totals is surfaced')
  assert.equal(res.unattributed.from, 20)               // 200 − 180
  assert.equal(res.unattributed.to, 50)                 // 300 − 250
  assert.equal(res.unattributed.delta, 30)              // 50 − 20
  // named (A:+60, B:+10) + unattributed (+30) = 100, exactly.
  assert.equal(res.contributors.reduce((a, c) => a + c.delta, 0) + res.unattributed.delta, res.total_delta)
  APPROX(shareSum(res), 1)
})

// ── the client UNION is taken: a new client rises from 0, a churned one falls to 0 ─
test('a client present in only one window counts from/to 0', () => {
  const newClient = contributionBreakdown('leads', [{ key: 'A', value: 100 }], [{ key: 'A', value: 100 }, { key: 'B', value: 50 }])
  assert.equal(newClient.total_delta, 50)
  const b = newClient.contributors.find((c) => c.key === 'B')
  assert.equal(b.from, 0)                                // B is new — rose from 0
  assert.equal(b.to, 50)
  assert.equal(b.share, 1)                               // it drove the entire rise

  const churned = contributionBreakdown('leads', [{ key: 'A', value: 100 }, { key: 'C', value: 40 }], [{ key: 'A', value: 100 }])
  assert.equal(churned.direction, 'down')
  assert.equal(churned.total_delta, -40)
  const c = churned.contributors.find((x) => x.key === 'C')
  assert.equal(c.to, 0)                                  // C churned — fell to 0
  assert.equal(c.share, 1)                               // aligned with the decline
  assert.equal(churned.lead.key, 'C')
})

// ── ratios are not additive → null, and the additive set is exactly the four ──
test('ratio metrics are not decomposable by client (null); the additive set is the four sums', () => {
  const from = [{ key: 'A', value: 4 }]
  const to   = [{ key: 'A', value: 5 }]
  for (const m of ['roas', 'cpl', 'close_rate']) {
    assert.equal(contributionBreakdown(m, from, to), null, `${m} → null`)
    assert.equal(isAdditive(m), false)
  }
  for (const m of ['revenue', 'leads', 'jobs', 'spend']) assert.equal(isAdditive(m), true)
  assert.deepEqual(additiveMetrics().sort(), ['jobs', 'leads', 'revenue', 'spend'])
  assert.ok(ADDITIVE instanceof Set)
  assert.equal(contributionBreakdown('bogus', from, to), null)
})

// ── a total that didn't move → null (nothing to attribute) ────────────────────
test('a flat total returns null (even when individual clients churned within it)', () => {
  // A −20, B +20 net to zero movement of the agency total.
  const from = [{ key: 'A', value: 100 }, { key: 'B', value: 50 }]
  const to   = [{ key: 'A', value: 80 },  { key: 'B', value: 70 }]
  assert.equal(contributionBreakdown('revenue', from, to), null)
  // and flat via authoritative equal totals.
  assert.equal(contributionBreakdown('revenue', from, to, { totalFrom: 200, totalTo: 200 }), null)
})

// ── a zero baseline → decomposes, but pct is null (no honest % of zero) ───────
test('a zero baseline decomposes with a null pct rather than dividing by zero', () => {
  const res = contributionBreakdown('jobs', [], [{ key: 'A', value: 7 }, { key: 'B', value: 3 }])
  assert.equal(res.direction, 'up')
  assert.equal(res.total_from, 0)
  assert.equal(res.total_delta, 10)
  assert.equal(res.pct, null)                            // 10/0 is not a real percentage
  APPROX(shareSum(res), 1)
})

// ── grounded narration: every number in the sentence comes from the result ────
test('narrateContribution is grounded — it emits no number absent from the result', () => {
  const from = [{ bucket: 'Acme', value: 100 }, { bucket: 'Globex', value: 50 }, { bucket: 'Initech', value: 30 }]
  const to   = [{ bucket: 'Acme', value: 160 }, { bucket: 'Globex', value: 60 }, { bucket: 'Initech', value: 20 }]
  const res = contributionBreakdown('revenue', from, to)

  // a raw formatter (numbers as-is) so we can compare emitted tokens to the source.
  const sentence = narrateContribution(res, { fmt: (v) => String(v), noun: 'revenue' })
  assert.ok(/^Revenue rose 60 \(\+33\.3%\)\./.test(sentence), `headline reads cleanly: "${sentence}"`)
  assert.ok(/Acme/.test(sentence) && /drove the most/.test(sentence), 'names the lead')

  // GROUNDING: every numeric token in the sentence must appear (by value) somewhere
  // in the result — a generous superset of all stored figures, as allowedNumbers does.
  const allowed = new Set()
  const add = (n) => { if (Number.isFinite(n)) { allowed.add(n); allowed.add(Math.abs(n)) } }
  add(res.total_from); add(res.total_to); add(res.total_delta); add(res.pct)
  for (const c of res.contributors) { add(c.from); add(c.to); add(c.delta); add(c.share_pct) }
  if (res.others) { add(res.others.delta); add(res.others.share_pct) }
  if (res.unattributed) { add(res.unattributed.delta); add(res.unattributed.share_pct) }
  for (const tok of sentence.match(/\d+(?:\.\d+)?/g) || []) {
    assert.ok(allowed.has(Number(tok)), `narration number ${tok} is grounded in the result`)
  }

  assert.equal(narrateContribution(null), '')           // no input → empty, no throw
  assert.equal(narrateContribution(res, {}).length > 0, true)   // a default fmt still works
})

// ── narration when the headline movers are all cushions → no false "driver" ───
test('narration names biggest moves without crowning a driver when the lead is null', () => {
  // Tiny +1 total carried by a wide tail; the two headline movers both OPPOSE it.
  const from = [{ key: 'A', value: 0 }, { key: 'B', value: 0 }, { key: 'C', value: 0 }, { key: 'D', value: 0 }, { key: 'E', value: 0 }]
  const to   = [{ key: 'A', value: -50 }, { key: 'B', value: -40 }, { key: 'C', value: 30 }, { key: 'D', value: 31 }, { key: 'E', value: 30 }]
  const res = contributionBreakdown('revenue', from, to, { limit: 2 })   // named = the two cushions A, B
  assert.equal(res.total_delta, 1)
  assert.ok(res.contributors.every((c) => c.share < 0), 'both named movers oppose the +move')
  assert.equal(res.lead, null, 'no single client is crowned the driver')
  const sentence = narrateContribution(res, { fmt: (v) => String(v), noun: 'revenue' })
  assert.ok(/Biggest moves:/.test(sentence), `falls back to biggest-moves phrasing: "${sentence}"`)
  assert.ok(!/drove the most/.test(sentence), 'does not crown a driver')
})

// ── robustness: malformed / empty / garbage never throws ──────────────────────
test('malformed, empty, and garbage input degrade safely', () => {
  assert.equal(contributionBreakdown('revenue', null, null), null)        // no rows, no move
  assert.equal(contributionBreakdown('revenue', [], []), null)
  assert.equal(contributionBreakdown('revenue', undefined, undefined), null)
  // garbage values coerce to 0 (additive); a single real mover still decomposes.
  const res = contributionBreakdown('revenue',
    [{ key: 'A', value: 'oops' }, { key: 'B', value: null }, null, { value: 5 /* no key */ }],
    [{ key: 'A', value: 100 }, { key: 'B', value: NaN }])
  assert.equal(res.total_to, 100)                        // A:100, B:NaN→0
  assert.equal(res.total_from, 0)                        // A:'oops'→0, B:null→0, keyless row skipped
  assert.equal(res.contributors.find((c) => c.key === 'A').delta, 100)
  APPROX(shareSum(res), 1)
  // a non-array `to` with a valid `from` → summedTo 0, decomposes as a decline.
  const decline = contributionBreakdown('leads', [{ key: 'A', value: 50 }], 'not-an-array')
  assert.equal(decline.direction, 'down')
  assert.equal(decline.total_delta, -50)
})
