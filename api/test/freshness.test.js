'use strict'

// ============================================================================
// test/freshness.test.js — the recency classifier behind every "live" badge (C1).
//
// lib/freshness.js lives in the FE tree (src/lib) as ESM so the useLiveStream
// hook and the liveness badges import it natively — one source of truth. node
// --test runs from api/ in CommonJS, so we reach the ESM module via a dynamic
// import of its relative path in a `before` hook. That keeps the FE-facing helper
// covered by the same API gate that guards the rest of the intelligence layer,
// with no duplicate copy to drift.
//
// We prove the four properties the badge layer depends on:
//   1. TOTALITY      — junk in → a defined 'unknown', never a throw.
//   2. BUCKETS       — live / recent / stale at exact, inclusive boundaries.
//   3. INPUT SHAPES  — Date, epoch-ms number, and ISO string all parse.
//   4. SKEW-SAFE     — a future timestamp clamps to age 0 and reads 'live'.
// ============================================================================

const { test, before } = require('node:test')
const assert            = require('node:assert/strict')

let F  // the dynamically-imported ESM module
before(async () => {
  F = await import('../../src/lib/freshness.js')
})

const NOW = 1_700_000_000_000   // a fixed reference instant for determinism

// ── 1. TOTALITY ───────────────────────────────────────────────────────────────
test('classifyFreshness is total — junk classifies as unknown, never throws', () => {
  for (const junk of [null, undefined, '', '   ', 'not-a-date', NaN, {}, [], true, () => {}]) {
    const r = F.classifyFreshness(junk, NOW)
    assert.equal(r.state, 'unknown', `${String(junk)} → unknown`)
    assert.equal(r.ageMs, null)
    assert.equal(r.fresh, false)
    assert.equal(r.label, 'no data')
  }
})

test('a bare numeric STRING is unknown (epoch must be a number, not a string)', () => {
  const r = F.classifyFreshness(String(NOW - 1000), NOW)
  assert.equal(r.state, 'unknown')
})

// ── 2. BUCKETS at exact, inclusive boundaries ──────────────────────────────────
test('boundaries are inclusive of the younger bucket', () => {
  const { liveMs, recentMs } = F.FRESHNESS_THRESHOLDS

  assert.equal(F.classifyFreshness(NOW,                 NOW).state, 'live')   // age 0
  assert.equal(F.classifyFreshness(NOW - liveMs,        NOW).state, 'live')   // age == liveMs (≤)
  assert.equal(F.classifyFreshness(NOW - liveMs - 1,    NOW).state, 'recent') // one ms past live
  assert.equal(F.classifyFreshness(NOW - recentMs,      NOW).state, 'recent') // age == recentMs (≤)
  assert.equal(F.classifyFreshness(NOW - recentMs - 1,  NOW).state, 'stale')  // one ms past recent
  assert.equal(F.classifyFreshness(NOW - 86_400_000,    NOW).state, 'stale')  // a day old
})

test('fresh boolean tracks the live state exactly', () => {
  assert.equal(F.classifyFreshness(NOW - 1_000,   NOW).fresh, true)
  assert.equal(F.classifyFreshness(NOW - 120_000, NOW).fresh, false)  // recent, not live
  assert.equal(F.classifyFreshness(NOW - 7_200_000, NOW).fresh, false) // stale
  assert.equal(F.classifyFreshness(null, NOW).fresh, false)            // unknown
})

test('ageMs is the exact integer gap', () => {
  assert.equal(F.classifyFreshness(NOW - 45_000, NOW).ageMs, 45_000)
})

test('custom thresholds override the defaults', () => {
  // a 10s live window, 30s recent window
  const opts = { liveMs: 10_000, recentMs: 30_000 }
  assert.equal(F.classifyFreshness(NOW - 5_000,  NOW, opts).state, 'live')
  assert.equal(F.classifyFreshness(NOW - 20_000, NOW, opts).state, 'recent')
  assert.equal(F.classifyFreshness(NOW - 40_000, NOW, opts).state, 'stale')
})

// ── 3. INPUT SHAPES — Date, number, ISO string ─────────────────────────────────
test('accepts a Date, an epoch-ms number, and an ISO string identically', () => {
  const asNumber = NOW - 30_000
  const asDate   = new Date(asNumber)
  const asIso    = new Date(asNumber).toISOString()

  assert.equal(F.classifyFreshness(asNumber, NOW).state, 'live')
  assert.equal(F.classifyFreshness(asDate,   NOW).state, 'live')
  assert.equal(F.classifyFreshness(asIso,    NOW).state, 'live')

  // now may itself be a Date
  assert.equal(F.classifyFreshness(asNumber, new Date(NOW)).state, 'live')
})

test('an Invalid Date is unknown, not a crash', () => {
  assert.equal(F.classifyFreshness(new Date('nonsense'), NOW).state, 'unknown')
})

// ── 4. SKEW-SAFE — future timestamps clamp to live ─────────────────────────────
test('a future timestamp (clock skew) clamps to age 0 and reads live', () => {
  const r = F.classifyFreshness(NOW + 60_000, NOW)  // 60s in the future
  assert.equal(r.state, 'live')
  assert.equal(r.ageMs, 0)
  assert.equal(r.label, 'just now')
})

test('now defaults to the real clock when omitted (recent past stays non-unknown)', () => {
  const r = F.classifyFreshness(Date.now() - 5_000)  // no explicit now
  assert.notEqual(r.state, 'unknown')
  assert.equal(typeof r.ageMs, 'number')
})

// ── formatAge — the only string the module emits, pure buckets ─────────────────
test('formatAge buckets seconds → minutes → hours → days', () => {
  assert.equal(F.formatAge(0),            'just now')
  assert.equal(F.formatAge(3_000),        'just now')   // < 5s
  assert.equal(F.formatAge(8_000),        '8s ago')
  assert.equal(F.formatAge(45_000),       '45s ago')
  assert.equal(F.formatAge(90_000),       '1m ago')
  assert.equal(F.formatAge(3_600_000),    '1h ago')
  assert.equal(F.formatAge(7_200_000),    '2h ago')
  assert.equal(F.formatAge(86_400_000),   '1d ago')
  assert.equal(F.formatAge(172_800_000),  '2d ago')
})

test('formatAge returns empty for non-finite or negative ages', () => {
  assert.equal(F.formatAge(NaN), '')
  assert.equal(F.formatAge(-1),  '')
  assert.equal(F.formatAge(Infinity), '')
})

// ── leak-safety: the label never carries anything but an age ───────────────────
test('the emitted label is age-only — safe on any surface', () => {
  const r = F.classifyFreshness(NOW - 600_000, NOW)  // 10 minutes
  assert.equal(r.label, '10m ago')
  // no currency, no client token — just a relative age
  assert.equal(/[$€£%]/.test(r.label), false)
})
