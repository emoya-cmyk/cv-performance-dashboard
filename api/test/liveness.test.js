'use strict'

// ============================================================================
// test/liveness.test.js — the badge state machine (intel-v13 C2, step a).
//
// lib/liveness.js folds useLiveStream's two signals (connected + lastEventAt)
// into one presentational verdict the shared <LiveBadge> renders on both the
// agency and client surfaces. It lives in the FE tree as ESM; node --test runs
// from api/ in CommonJS, so we reach it (and the C1 freshness thresholds it
// composes) via a dynamic import in a `before` hook — same one-source-of-truth
// pattern as freshness.test.js.
//
// We prove the properties the badge depends on:
//   1. TRANSPORT DOMINATES — connected:false ⇒ 'offline' even with a fresh event.
//   2. STATE MACHINE       — live / connected / offline at exact recency boundaries.
//   3. TOTALITY            — junk/empty signals never throw.
//   4. LEAK-SAFE           — label + detail carry only age, never a figure/tenant.
// ============================================================================

const { test, before } = require('node:test')
const assert           = require('node:assert/strict')

let L  // lib/liveness.js
let F  // lib/freshness.js — for its threshold constants
before(async () => {
  L = await import('../../src/lib/liveness.js')
  F = await import('../../src/lib/freshness.js')
})

const NOW = 1_700_000_000_000   // fixed reference instant for determinism

// ── 1. TRANSPORT DOMINATES ─────────────────────────────────────────────────────
test('connected:false is offline even when the last event is brand-new', () => {
  // lastEventAt = NOW would classify as freshness 'live', but the pipe is down.
  const r = L.summarizeLiveness({ connected: false, lastEventAt: NOW }, NOW)
  assert.equal(r.state, 'offline')
  assert.equal(r.tone,  'muted')
  assert.equal(r.pulse, false)
  assert.equal(r.label, L.LIVENESS_LABELS.offline)
  assert.equal(r.live,  false)
})

test('offline detail is "reconnecting…" with no prior data, else the last age', () => {
  const cold = L.summarizeLiveness({ connected: false, lastEventAt: null }, NOW)
  assert.equal(cold.state, 'offline')
  assert.equal(cold.detail, 'reconnecting…')

  const warm = L.summarizeLiveness({ connected: false, lastEventAt: NOW - 300_000 }, NOW) // 5m
  assert.equal(warm.state, 'offline')
  assert.equal(warm.detail, 'updated 5m ago')
})

// ── 2. STATE MACHINE at exact recency boundaries ───────────────────────────────
test('connected + event within the live window → live (pulsing, positive)', () => {
  const r = L.summarizeLiveness({ connected: true, lastEventAt: NOW - 10_000 }, NOW)
  assert.equal(r.state, 'live')
  assert.equal(r.tone,  'positive')
  assert.equal(r.pulse, true)
  assert.equal(r.label, L.LIVENESS_LABELS.live)
  assert.equal(r.live,  true)
  assert.equal(r.detail, 'updated 10s ago')
})

test('the live boundary is inclusive (age == liveMs is still live)', () => {
  const { liveMs } = F.FRESHNESS_THRESHOLDS
  const r = L.summarizeLiveness({ connected: true, lastEventAt: NOW - liveMs }, NOW)
  assert.equal(r.state, 'live')
  // one ms past the window → no longer live, but still connected
  const past = L.summarizeLiveness({ connected: true, lastEventAt: NOW - liveMs - 1 }, NOW)
  assert.equal(past.state, 'connected')
})

test('connected but quiet (recent or stale event) → connected (neutral, steady)', () => {
  const recent = L.summarizeLiveness({ connected: true, lastEventAt: NOW - 300_000 }, NOW)  // 5m
  assert.equal(recent.state, 'connected')
  assert.equal(recent.tone,  'neutral')
  assert.equal(recent.pulse, false)
  assert.equal(recent.label, L.LIVENESS_LABELS.connected)
  assert.equal(recent.live,  false)
  assert.equal(recent.detail, 'updated 5m ago')

  const stale = L.summarizeLiveness({ connected: true, lastEventAt: NOW - 7_200_000 }, NOW) // 2h
  assert.equal(stale.state, 'connected')   // pipe open, just old — not offline
  assert.equal(stale.detail, 'updated 2h ago')
})

test('connected with no event yet → connected, "awaiting activity"', () => {
  const r = L.summarizeLiveness({ connected: true, lastEventAt: null }, NOW)
  assert.equal(r.state, 'connected')
  assert.equal(r.detail, 'awaiting activity')
  assert.equal(r.live, false)
})

// ── 3. TOTALITY — junk/empty never throws ──────────────────────────────────────
test('empty, missing, and junk signals classify as offline without throwing', () => {
  // Each of these either omits connected or sets it falsy → honestly offline.
  // (A truthy non-boolean connected is covered by the next test, not here.)
  for (const junk of [undefined, null, {}, { connected: false }, { lastEventAt: 'nope' }, [], 0]) {
    const r = L.summarizeLiveness(junk, NOW)
    assert.ok(L.LIVENESS_STATES.includes(r.state), `${JSON.stringify(junk)} → a known state`)
    // none of these assert connected truthiness honestly, so all read offline
    assert.equal(r.state, 'offline')
    assert.equal(r.live, false)
  }
})

test('a truthy non-boolean connected still works; ageMs passes through', () => {
  const r = L.summarizeLiveness({ connected: 1, lastEventAt: NOW - 20_000 }, NOW)
  assert.equal(r.state, 'live')
  assert.equal(r.ageMs, 20_000)

  const unknown = L.summarizeLiveness({ connected: true, lastEventAt: null }, NOW)
  assert.equal(unknown.ageMs, null)
})

// ── input-shape parity: now may be a Date; lastEventAt may be ISO/Date ──────────
test('now-as-Date and ISO/Date lastEventAt classify identically to epoch ms', () => {
  const at = NOW - 15_000
  const a = L.summarizeLiveness({ connected: true, lastEventAt: at }, NOW)
  const b = L.summarizeLiveness({ connected: true, lastEventAt: new Date(at) }, new Date(NOW))
  const c = L.summarizeLiveness({ connected: true, lastEventAt: new Date(at).toISOString() }, NOW)
  assert.equal(a.state, 'live')
  assert.equal(b.state, 'live')
  assert.equal(c.state, 'live')
  assert.equal(a.detail, b.detail)
  assert.equal(a.detail, c.detail)
})

test('now defaults to the real clock when omitted', () => {
  const r = L.summarizeLiveness({ connected: true, lastEventAt: Date.now() - 5_000 })
  assert.equal(r.state, 'live')
})

// ── 4. LEAK-SAFE — label + detail are age-only, safe on any surface ─────────────
test('label and detail never carry a figure or tenant token, in any state', () => {
  const cases = [
    L.summarizeLiveness({ connected: false, lastEventAt: null }, NOW),
    L.summarizeLiveness({ connected: false, lastEventAt: NOW - 600_000 }, NOW),
    L.summarizeLiveness({ connected: true,  lastEventAt: NOW - 5_000 }, NOW),
    L.summarizeLiveness({ connected: true,  lastEventAt: NOW - 600_000 }, NOW),
    L.summarizeLiveness({ connected: true,  lastEventAt: null }, NOW),
  ]
  for (const r of cases) {
    assert.equal(/[$€£%]/.test(r.label),  false, `label leak-safe: ${r.label}`)
    assert.equal(/[$€£%]/.test(r.detail), false, `detail leak-safe: ${r.detail}`)
  }
})

test('live convenience boolean equals (state === "live") across the machine', () => {
  const samples = [
    [{ connected: true,  lastEventAt: NOW - 1_000 },   true],
    [{ connected: true,  lastEventAt: NOW - 600_000 }, false],
    [{ connected: true,  lastEventAt: null },          false],
    [{ connected: false, lastEventAt: NOW },           false],
  ]
  for (const [sig, expected] of samples) {
    const r = L.summarizeLiveness(sig, NOW)
    assert.equal(r.live, expected)
    assert.equal(r.live, r.state === 'live')
  }
})
