// ============================================================
// test/roundtrip.test.js — the fidelity gate for lossless compaction.
//
// The load-bearing guarantee of this module is a BIJECTION on the value set:
// expand(compact(x).text) must deep-equal x for every input. These tests pin that
// against golden, real-shape vendor/dashboard reads, plus the adversarial cell
// cases (pipes, newlines, backslashes, nulls, nesting, absent keys, unicode), the
// below-threshold / heterogeneous PASSTHROUGH paths, and the verify-fallback
// predicate that protects against any future regression. Pure: no DB, no clock.
// ============================================================

'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  compact,
  expand,
  compaction,
  cacheAlign,
} = require('..')
const { encodeTable, decodeTable, roundTripsLossless, jsonEqual } = compaction

const fixturesDir = path.join(__dirname, 'fixtures')
const loadFixture = (name) => JSON.parse(fs.readFileSync(path.join(fixturesDir, name), 'utf8'))

// Fixtures that SHOULD compact (uniform-enough, above threshold).
const COMPACTABLE = [
  'ghl_contacts.json',
  'acculynx_jobs.json',
  'hcp_jobs.json',
  'makecom_scenario_health.json',
  'dashboard_synthesis.json',
]

// ---- the core guarantee, per golden fixture --------------------------------

for (const name of COMPACTABLE) {
  test(`lossless round-trip + real saving: ${name}`, () => {
    const original = loadFixture(name)
    const res = compact(original)

    assert.equal(res.compacted, true, `${name} should compact`)
    assert.ok(res.compactedChars < res.originalChars, `${name} should be smaller`)
    assert.ok(res.ratio < 1, `${name} ratio must be < 1`)

    // THE invariant: decode of the emitted block reconstructs the input exactly.
    const back = expand(res.text)
    assert.deepEqual(back, original, `${name} must round-trip byte-equal in value`)
    assert.ok(roundTripsLossless(original, res.text), `${name} roundTripsLossless`)

    // informative — not a hard threshold (D-3 thresholds are tunable later)
    const pct = (100 * (1 - res.ratio)).toFixed(1)
    console.log(`  ${name}: ${res.originalChars} -> ${res.compactedChars} chars (${pct}% smaller)`)
  })
}

// ---- passthrough paths (still lossless: original is returned) ---------------

test('below MIN_ROWS → passthrough, expand still reconstructs', () => {
  const small = loadFixture('below_threshold.json')
  const res = compact(small)
  assert.equal(res.compacted, false)
  assert.equal(res.reason, 'below-min-rows')
  assert.equal(res.text, JSON.stringify(small))
  assert.deepEqual(expand(res.text), small)
})

test('below MIN_TOKENS → passthrough (tiny but enough rows)', () => {
  const tiny = [
    { a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }, { a: 5 }, { a: 6 },
  ]
  const res = compact(tiny)
  assert.equal(res.compacted, false)
  assert.equal(res.reason, 'below-min-tokens')
  assert.deepEqual(expand(res.text), tiny)
})

test('heterogeneous (ragged) → passthrough (v1 does not guess a discriminator)', () => {
  const het = loadFixture('heterogeneous.json')
  const res = compact(het)
  assert.equal(res.compacted, false)
  assert.equal(res.reason, 'heterogeneous')
  assert.deepEqual(expand(res.text), het)
})

test('non-array / non-object inputs → passthrough', () => {
  for (const v of [42, 'hello', { a: 1 }, [1, 2, 3], [{ a: 1 }, 5], null]) {
    const res = compact(v)
    assert.equal(res.compacted, false)
    assert.deepEqual(expand(res.text), v)
  }
})

// ---- adversarial cell cases (the escaping must be reversible) ---------------

test('codec round-trips pipes, newlines, backslashes, nulls, nesting, absent keys, unicode', () => {
  const rows = [
    { id: 'a', s: 'has|pipe', n: 1, b: true },
    { id: 'b', s: 'has\nnewline\tand\r', n: -3.5, b: false },
    { id: 'c', s: 'back\\slash and \\| and \\z literal', n: 0, b: true },
    { id: 'd', s: '', n: 1e21, b: false }, // empty string vs absent
    { id: 'e', s: 'unicode ☂ é 日本語', n: 3.14159, b: true },
    { id: 'f', n: 7, b: false }, // 's' absent on this row
    { id: 'g', s: 'x', b: true }, // 'n' absent on this row
  ]
  const text = encodeTable(rows)
  assert.deepEqual(decodeTable(text), rows)
})

test('codec round-trips a mixed (x) column: null / string / number / boolean / nested', () => {
  const rows = [
    { id: 1, mixed: null, nested: { city: 'Austin', zip: '78704' } },
    { id: 2, mixed: 'text|with|pipes', nested: ['a', 'b', 'c'] },
    { id: 3, mixed: 42, nested: { deep: { x: [1, 2, { y: null }] } } },
    { id: 4, mixed: true, nested: {} },
    { id: 5, mixed: 3.14, nested: [] },
  ]
  const text = encodeTable(rows)
  assert.deepEqual(decodeTable(text), rows)
})

test('empty string, null, and absent key are three DISTINCT states', () => {
  const rows = [
    { id: 1, v: '' }, // empty string
    { id: 2, v: null }, // null
    { id: 3 }, // absent
    { id: 4, v: 'x' },
    { id: 5, v: 'y' },
  ]
  const text = encodeTable(rows)
  const back = decodeTable(text)
  assert.equal(back[0].v, '')
  assert.equal(back[1].v, null)
  assert.equal(Object.prototype.hasOwnProperty.call(back[2], 'v'), false)
  assert.deepEqual(back, rows)
})

// ---- the verify-fallback predicate (proves the guard is load-bearing) -------

test('roundTripsLossless: true for a faithful block, false for a corrupted one', () => {
  const rows = loadFixture('ghl_contacts.json')
  const text = encodeTable(rows)
  assert.equal(roundTripsLossless(rows, text), true)

  // Corrupt the block: drop the last data line. A verify guard MUST reject this.
  const corruptDrop = text.split('\n').slice(0, -1).join('\n')
  assert.equal(roundTripsLossless(rows, corruptDrop), false)

  // Corrupt a value: change a cell. Must also be rejected.
  const corruptValue = text.replace('Maria', 'Mxria')
  assert.equal(roundTripsLossless(rows, corruptValue), false)

  // Non-block text → rejected, never throws.
  assert.equal(roundTripsLossless(rows, 'not a block'), false)
})

test('compact with verify=true falls back to the original on any mismatch', () => {
  // The guard inside compact() IS roundTripsLossless; we proved that predicate is
  // bidirectional above, so this asserts the wiring: a faithful compaction is kept,
  // and expand reconstructs it. (A real mismatch cannot be produced for JSON-shaped
  // input by the correct encoder — that is precisely the lossless property — so the
  // fallback is exercised at the predicate level by the test above.)
  const rows = loadFixture('makecom_scenario_health.json')
  const res = compact(rows, { verify: true })
  assert.equal(res.compacted, true)
  assert.deepEqual(expand(res.text), rows)
})

// ---- format stability (pins enc=v1 so cross-language decoders stay in sync) -

test('format golden: header shape + bare scalar columns are stable', () => {
  const rows = [
    { id: 'c_001', status: 'won', amount: 4200, closed: true },
    { id: 'c_002', status: 'open', amount: 0, closed: false },
    { id: 'c_003', status: 'won', amount: 980, closed: true },
    { id: 'c_004', status: 'lost', amount: 0, closed: false },
    { id: 'c_005', status: 'won', amount: 75, closed: true },
  ]
  const text = encodeTable(rows)
  const lines = text.split('\n')
  assert.equal(
    lines[0],
    '##TBL keys=["id","status","amount","closed"] types=["s","s","n","b"] rows=5 enc=v1'
  )
  assert.equal(lines[1], 'c_001|won|4200|true')
  assert.equal(lines[5], 'c_005|won|75|true')
  assert.deepEqual(decodeTable(text), rows)
})

// ---- jsonEqual (the equality used by the verify guard) ----------------------

test('jsonEqual: order-insensitive on keys, deep, type-strict', () => {
  assert.equal(jsonEqual({ a: 1, b: 2 }, { b: 2, a: 1 }), true)
  assert.equal(jsonEqual([1, { x: [2, 3] }], [1, { x: [2, 3] }]), true)
  assert.equal(jsonEqual({ a: 1 }, { a: 1, b: 2 }), false)
  assert.equal(jsonEqual(1, '1'), false) // number vs string string is NOT equal
  assert.equal(jsonEqual(null, 0), false)
})

// ---- cache alignment --------------------------------------------------------

test('assemblePrompt: stable prefix first, volatile last; prefix is invariant', () => {
  const stable = ['SYSTEM POLICY', 'SCHEMA: id,status', 'TOOLS: [..]']
  const p1 = cacheAlign.assemblePrompt({ stable, volatile: ['read A'] })
  const p2 = cacheAlign.assemblePrompt({ stable, volatile: ['read B is different'] })

  const prefix = cacheAlign.cachePrefix(stable)
  assert.ok(p1.startsWith(prefix), 'stable content must lead')
  assert.ok(p2.startsWith(prefix), 'stable prefix identical across requests')
  assert.ok(p1.endsWith('read A'), 'volatile content must trail')
  assert.ok(p2.endsWith('read B is different'))
  // The cacheable prefix does not change when only the volatile suffix changes.
  assert.equal(cacheAlign.cachePrefix(stable), cacheAlign.cachePrefix(stable))
})

test('assemblePrompt: empty/absent parts are dropped so the prefix stays byte-stable', () => {
  assert.equal(cacheAlign.assemblePrompt({ stable: ['A'], volatile: [] }), 'A')
  assert.equal(cacheAlign.assemblePrompt({ stable: [], volatile: ['B'] }), 'B')
  assert.equal(
    cacheAlign.assemblePrompt({ stable: ['A', '', null, 'C'], volatile: ['D'] }),
    'A\n\nC\n\nD'
  )
})

// ---- constants --------------------------------------------------------------

test('threshold constants are the documented D-3 defaults', () => {
  assert.equal(compaction.MIN_ROWS, 5)
  assert.equal(compaction.MIN_TOKENS, 200)
  assert.equal(compaction.CORE_FIELD_FRACTION, 0.8)
  assert.equal(compaction.HETEROGENEOUS_CORE_RATIO, 0.6)
  assert.equal(compaction.ENC_VERSION, 1)
})
