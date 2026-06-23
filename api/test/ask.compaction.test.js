'use strict'

// ============================================================
// ask.compaction.test.js — G3: lossless tabular compaction of the rows we send
// the "ask" narrator (lib/ask.js buildNarrateContent), proving the gate's two
// invariants: (1) every row value survives the reformat exactly (so the grounding
// allow-set, computed from rows not the prompt string, is unchanged), and (2) a
// small result is byte-identical to the legacy inline-JSON prompt. Plus a measured
// size reduction on a high-cardinality (group_by=client) result. Pure: no network.
// ============================================================

const test = require('node:test')
const assert = require('node:assert')

const { buildNarrateContent, allowedNumbersForAsk } = require('../lib/ask')
const { expand } = require('../vendor/compaction')

// A realistic group_by=client payload (the high-cardinality ask shape).
function clientPayload (n = 15) {
  const rows = []
  for (let i = 0; i < n; i++) {
    rows.push({ bucket: `Client ${String.fromCharCode(65 + i)}`, value: 1000 + i * 137, display: `$${(1000 + i * 137).toLocaleString()}` })
  }
  return {
    question: 'Which clients drove the most revenue last month?',
    metric: 'Revenue', unit: 'usd', time_period: 'last month', group_by: 'client',
    rows,
    comparison: { versus: 'the prior month', direction: 'up', change_display: '12.4%', baseline_display: '$18,000' },
  }
}

test('large result → lossless ##TBL block; every row value is preserved exactly', () => {
  const payload = clientPayload(15)
  const content = buildNarrateContent(payload)

  assert.ok(content.includes('##TBL'), 'rows should be compacted into a ##TBL block')

  // Recover the block and prove it round-trips to the exact rows the model must
  // ground on — no value dropped, substituted, or reordered. (The real block
  // begins at the header line `##TBL keys=`; the prose legend mentions `##TBL:`.)
  const block = content.slice(content.indexOf('##TBL keys='))
  assert.deepStrictEqual(expand(block), payload.rows, 'compact rows must reconstruct byte-equal')

  // Grounding is unaffected: the allow-set is derived from rows, and every row
  // value is present in the reconstructed block (so the verifier sees identical
  // numbers whether or not we compacted).
  const allowed = allowedNumbersForAsk(payload.rows, payload.time_period, payload.comparison)
  for (const r of payload.rows) assert.ok(allowed.has(r.value), `value ${r.value} must be groundable`)
})

test('small result → byte-identical to the legacy inline-JSON prompt', () => {
  const payload = {
    question: 'What was revenue last week?',
    metric: 'Revenue', unit: 'usd', time_period: 'last week', group_by: 'none',
    rows: [{ value: 42000, display: '$42,000' }],
  }
  const content = buildNarrateContent(payload)
  assert.equal(content, 'Answer this, grounded only in the rows:\n\n' + JSON.stringify(payload))
  assert.ok(!content.includes('##TBL'))
})

test('compaction shrinks the high-cardinality prompt (measured)', () => {
  const payload = clientPayload(20)
  const legacy = 'Answer this, grounded only in the rows:\n\n' + JSON.stringify(payload)
  const compacted = buildNarrateContent(payload)
  assert.ok(compacted.length < legacy.length, 'compacted prompt must be smaller')
  const pct = (100 * (1 - compacted.length / legacy.length)).toFixed(1)
  console.log(`  ask group_by=client (${payload.rows.length} rows): ${legacy.length} -> ${compacted.length} chars (${pct}% smaller)`)
})
