'use strict'

// Unit tests for lib/writeVerification — the pure correctness verdict (Spec A).
// No DB, no I/O: field normalization/equivalence, the four-state classifier,
// the Wilson lower bound, and the outcome → confidence-key mapping.

const { test } = require('node:test')
const assert = require('node:assert/strict')

const {
  OUTCOME,
  normalizeValue,
  compareReadback,
  classifyWrite,
  hashIntended,
  wilsonLowerBound,
  outcomeToWilsonFeedback,
} = require('../lib/writeVerification')

// ── normalizeValue ──────────────────────────────────────────────────────────

test('normalizeValue is case/whitespace-insensitive and treats null as empty', () => {
  assert.equal(normalizeValue('  Hello   World '), 'hello world')
  assert.equal(normalizeValue(null), '')
  assert.equal(normalizeValue(undefined), '')
  assert.equal(normalizeValue(42), '42')
  assert.equal(normalizeValue(true), 'true')
})

test('normalizeValue applies type-aware rules for phone/email', () => {
  assert.equal(normalizeValue('(555) 123-4567', { kind: 'phone' }), '5551234567')
  assert.equal(normalizeValue('User@Example.COM', { kind: 'email' }), 'user@example.com')
})

test('normalizeValue translates through a per-field equivalence map first', () => {
  const map = { Y: 'yes', N: 'no' }
  assert.equal(normalizeValue('Y', { map }), 'yes')
  assert.equal(normalizeValue('yes', { map }), 'yes') // already canonical
})

// ── compareReadback ─────────────────────────────────────────────────────────

test('compareReadback reports a full match on normalized values', () => {
  const cmp = compareReadback(
    { name: 'Jane Doe', phone: '5551234567' },
    { name: 'jane  doe', phone: '(555) 123-4567' },
    { equivalence: { phone: { kind: 'phone' } } }
  )
  assert.equal(cmp.readBackAvailable, true)
  assert.equal(cmp.allMatch, true)
  assert.equal(cmp.fieldCount, 2)
  assert.equal(cmp.matchCount, 2)
  assert.deepEqual(cmp.mismatchFields, [])
})

test('compareReadback flags the specific mismatched fields', () => {
  const cmp = compareReadback(
    { name: 'Jane', status: 'won' },
    { name: 'Jane', status: 'lost' }
  )
  assert.equal(cmp.allMatch, false)
  assert.deepEqual(cmp.mismatchFields, ['status'])
  assert.equal(cmp.matchCount, 1)
})

test('compareReadback marks the read unavailable when readBack is null/undefined', () => {
  for (const rb of [null, undefined]) {
    const cmp = compareReadback({ a: 1 }, rb)
    assert.equal(cmp.readBackAvailable, false)
    assert.equal(cmp.allMatch, false)
    assert.equal(cmp.fields[0].match, null)
  }
})

test('compareReadback only judges fields present in intent (extra read-back keys ignored)', () => {
  const cmp = compareReadback({ a: '1' }, { a: '1', b: 'noise' })
  assert.equal(cmp.fieldCount, 1)
  assert.equal(cmp.allMatch, true)
})

// ── classifyWrite (the four-state axis) ─────────────────────────────────────

test('classifyWrite: not persisted → FAILED', () => {
  assert.equal(classifyWrite({ persisted: false }), OUTCOME.FAILED)
  assert.equal(
    classifyWrite({ persisted: false, comparison: compareReadback({ a: 1 }, { a: 1 }) }),
    OUTCOME.FAILED
  )
})

test('classifyWrite: persisted but no read-back → PERSISTED_UNVERIFIED', () => {
  assert.equal(classifyWrite({ persisted: true }), OUTCOME.PERSISTED_UNVERIFIED)
  assert.equal(
    classifyWrite({ persisted: true, comparison: compareReadback({ a: 1 }, null) }),
    OUTCOME.PERSISTED_UNVERIFIED
  )
})

test('classifyWrite: persisted + mismatch → PERSISTED_INCORRECT (distinct from FAILED)', () => {
  const cmp = compareReadback({ a: '1' }, { a: '2' })
  assert.equal(classifyWrite({ persisted: true, comparison: cmp }), OUTCOME.PERSISTED_INCORRECT)
})

test('classifyWrite: persisted + round-trip match → VERIFIED_CORRECT', () => {
  const cmp = compareReadback({ a: '1' }, { a: '1' })
  assert.equal(classifyWrite({ persisted: true, comparison: cmp }), OUTCOME.VERIFIED_CORRECT)
})

// ── hashIntended ────────────────────────────────────────────────────────────

test('hashIntended is stable across key order and sensitive to value change', () => {
  const h1 = hashIntended({ a: 'X', b: 'Y' })
  const h2 = hashIntended({ b: 'y', a: 'x' }) // reordered + different case (normalized away)
  assert.equal(h1, h2)
  const h3 = hashIntended({ a: 'X', b: 'Z' })
  assert.notEqual(h1, h3)
})

// ── wilsonLowerBound ────────────────────────────────────────────────────────

test('wilsonLowerBound is 0 for an empty sample and below the point estimate', () => {
  assert.equal(wilsonLowerBound(0, 0), 0)
  const lb = wilsonLowerBound(8, 10)
  assert.ok(lb > 0 && lb < 0.8, `expected 0 < ${lb} < 0.8`)
})

test('wilsonLowerBound rises with more confirming samples at the same rate', () => {
  const small = wilsonLowerBound(9, 10)
  const large = wilsonLowerBound(90, 100)
  assert.ok(large > small, `more samples should tighten the bound up (${large} > ${small})`)
})

// ── outcomeToWilsonFeedback ─────────────────────────────────────────────────

test('outcomeToWilsonFeedback maps correctness (not persistence) to the dormant key', () => {
  assert.equal(outcomeToWilsonFeedback(OUTCOME.VERIFIED_CORRECT), 'tier1_remapped_verified')
  assert.equal(outcomeToWilsonFeedback(OUTCOME.PERSISTED_INCORRECT), 'tier1_dead_lettered')
  assert.equal(outcomeToWilsonFeedback(OUTCOME.FAILED), 'tier1_dead_lettered')
  assert.equal(outcomeToWilsonFeedback(OUTCOME.PERSISTED_UNVERIFIED), null)
})
