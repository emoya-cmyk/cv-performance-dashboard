'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const {
  metricContinuity,
  summarizeContinuity,
  narrateContinuity,
  narrateResolved,
  ordinal,
  DEFAULT_MEMORY,
  DEFAULT_DEADBAND_PCT,
} = require('../lib/pulseContinuity')

// ---------------------------------------------------------------------------
// Fixtures. We drive metricContinuity with window=1 so each "morning" prefix
// differs from the next by exactly ONE day — the crisp granularity continuity
// reasons over. base(n) is a repeating [100,90,110] cycle: for ANY truncation
// length ≥3 its median stays ≈100 and robustStd ≈14.8, so a baseline day reads
// |z|<1 (never fires) while a deep drop reads |z|≫3 (always fires). That makes
// every morning's verdict deterministic and hand-verifiable.
// ---------------------------------------------------------------------------
const base = (n) => Array.from({ length: n }, (_, i) => [100, 90, 110][i % 3])
// window=1 → "trailing 1-day sum" is just the last value; adverse on drops.
const OPTS = { window: 1, minWindows: 3, adverseWhen: 'drop' }

// ===========================================================================
// metricContinuity — status derivation across mornings
// ===========================================================================

test('new: fires today, clear the prior morning → status new, streak 1', () => {
  // base(9) of calm days, then today drops to 0. Only today fires.
  const c = metricContinuity([...base(9), 0], OPTS)
  assert.equal(c.status, 'new')
  assert.equal(c.firing_today, true)
  assert.equal(c.prev_firing, false)
  assert.equal(c.streak, 1)
  assert.equal(c.since_back, 0)
  assert.equal(c.streak_capped, false)
  assert.equal(c.reason, 'first_morning')
})

test('persisting: fires today AND the prior morning → streak counts the run', () => {
  // two trailing drop days → today and yesterday both fire.
  const c = metricContinuity([...base(8), 0, 0], OPTS)
  assert.equal(c.status, 'persisting')
  assert.equal(c.firing_today, true)
  assert.equal(c.prev_firing, true)
  assert.equal(c.streak, 2)
  assert.equal(c.since_back, 1)
  assert.equal(c.reason, 'continuing')
})

test('resolved: clear today but fired yesterday → status resolved (a win)', () => {
  // yesterday dropped to 0; today recovered to a normal 100.
  const c = metricContinuity([...base(8), 0, 100], OPTS)
  assert.equal(c.status, 'resolved')
  assert.equal(c.firing_today, false)
  assert.equal(c.prev_firing, true)
  assert.equal(c.streak, 0)
  assert.equal(c.since_back, null)
  assert.equal(c.reason, 'cleared')
})

test('quiet: clear today and yesterday → status quiet, no streak', () => {
  const c = metricContinuity([...base(12)], OPTS)
  assert.equal(c.status, 'quiet')
  assert.equal(c.firing_today, false)
  assert.equal(c.prev_firing, false)
  assert.equal(c.streak, 0)
  assert.equal(c.trend, null)
  assert.equal(c.reason, 'no_alarm')
})

// ===========================================================================
// metricContinuity — trend (worsening / easing / steady)
// ===========================================================================

test('trend worsening: today is further from baseline than yesterday', () => {
  // yesterday -60% (40 vs 100), today -100% (0 vs 100): gap widened past deadband.
  const c = metricContinuity([...base(8), 40, 0], OPTS)
  assert.equal(c.status, 'persisting')
  assert.equal(c.trend, 'worsening')
  assert.ok(Number.isFinite(c.delta_today) && Number.isFinite(c.delta_prev))
  assert.ok(Math.abs(c.delta_today) > Math.abs(c.delta_prev))
})

test('trend easing: today is closer to baseline than yesterday', () => {
  // yesterday -100% (0), today -60% (40): still firing but recovering.
  const c = metricContinuity([...base(8), 0, 40], OPTS)
  assert.equal(c.status, 'persisting')
  assert.equal(c.trend, 'easing')
  assert.ok(Math.abs(c.delta_today) < Math.abs(c.delta_prev))
})

test('trend steady: two comparable drops stay within the deadband', () => {
  const c = metricContinuity([...base(8), 0, 0], OPTS)
  assert.equal(c.trend, 'steady')
})

test('trend is null unless BOTH today and the prior morning fire', () => {
  const fresh = metricContinuity([...base(9), 0], OPTS) // new → only today fires
  assert.equal(fresh.trend, null)
  const calm = metricContinuity([...base(12)], OPTS)
  assert.equal(calm.trend, null)
})

// ===========================================================================
// metricContinuity — streak capping & honest abstention
// ===========================================================================

test('streak_capped: a run that fills the whole memory window flags "at least"', () => {
  // four trailing drops but only 3 mornings of memory → the true run is longer.
  const c = metricContinuity([...base(8), 0, 0, 0, 0], { ...OPTS, memory: 3 })
  assert.equal(c.memory_used, 3)
  assert.equal(c.streak, 3)
  assert.equal(c.streak_capped, true)
})

test('streak not capped when the run is fully observed inside the window', () => {
  const c = metricContinuity([...base(8), 0, 0], { ...OPTS, memory: 7 })
  assert.equal(c.streak, 2)
  assert.equal(c.streak_capped, false)
})

test('insufficient history abstains as "no alarm" — never a guess', () => {
  // only two days: dayPulse can't form a baseline → every morning insufficient.
  const c = metricContinuity([100, 0], OPTS)
  assert.equal(c.status, 'quiet')
  assert.equal(c.firing_today, false)
  assert.equal(c.prev_firing, false)
  assert.equal(c.memory_used, 2)
})

test('window forwarded to dayPulse is echoed back on the descriptor', () => {
  const c = metricContinuity([...base(9), 0], { ...OPTS, window: 1 })
  assert.equal(c.window, 1)
})

// ===========================================================================
// metricContinuity — totality on empty / garbage input (never throws)
// ===========================================================================

test('empty / null input → calm quiet descriptor, no throw', () => {
  for (const v of [[], null, undefined, 'nope', 42]) {
    let c
    assert.doesNotThrow(() => { c = metricContinuity(v, OPTS) })
    assert.equal(c.status, 'quiet')
    assert.equal(c.firing_today, false)
    assert.equal(c.streak, 0)
    assert.equal(c.memory_used, 0)
  }
})

test('non-finite values are tolerated (dayPulse zero-fills) — no throw', () => {
  assert.doesNotThrow(() => metricContinuity([NaN, 'x', null, 100, 90, 110, 0], OPTS))
})

// ===========================================================================
// metricContinuity — purity (input is never mutated)
// ===========================================================================

test('metricContinuity does not mutate its input', () => {
  const src = [...base(8), 40, 0]
  const snapshot = src.slice()
  Object.freeze(src)
  assert.doesNotThrow(() => metricContinuity(src, OPTS))
  assert.deepEqual(src, snapshot)
})

// ===========================================================================
// summarizeContinuity — machinery-free briefing memory
// ===========================================================================

const cont = (over) => ({
  status: 'quiet', firing_today: false, prev_firing: false,
  streak: 0, streak_capped: false, since_back: null, trend: null,
  delta_today: null, delta_prev: null, memory_used: 7, window: 7, reason: 'no_alarm',
  ...over,
})

test('summarizeContinuity folds per-metric memory into counts + focus + resolved', () => {
  const items = [
    { metric: 'leads', label: 'Leads', is_focus: true, continuity: cont({ status: 'persisting', firing_today: true, prev_firing: true, streak: 3, since_back: 2, trend: 'worsening' }) },
    { metric: 'revenue', label: 'Revenue', is_focus: false, continuity: cont({ status: 'new', firing_today: true, streak: 1 }) },
    { metric: 'roas', label: 'ROAS', is_focus: false, continuity: cont({ status: 'resolved', prev_firing: true }) },
    { metric: 'cpl', label: 'CPL', is_focus: false, continuity: cont({ status: 'quiet' }) },
  ]
  const s = summarizeContinuity(items)
  assert.equal(s.new_count, 1)
  assert.equal(s.persisting_count, 1)
  assert.equal(s.escalating_count, 1) // leads is persisting AND worsening
  assert.deepEqual(s.resolved, [{ metric: 'roas', label: 'ROAS' }])
  assert.deepEqual(s.focus, {
    metric: 'leads', label: 'Leads', status: 'persisting',
    streak: 3, streak_capped: false, since_back: 2, trend: 'worsening',
  })
})

test('summarizeContinuity focus is null when the focus metric is not firing today', () => {
  const items = [
    { metric: 'roas', label: 'ROAS', is_focus: true, continuity: cont({ status: 'resolved', prev_firing: true }) },
    { metric: 'leads', label: 'Leads', is_focus: false, continuity: cont({ status: 'new', firing_today: true, streak: 1 }) },
  ]
  const s = summarizeContinuity(items)
  assert.equal(s.focus, null)
  assert.equal(s.new_count, 1)
  assert.deepEqual(s.resolved, [{ metric: 'roas', label: 'ROAS' }])
})

test('summarizeContinuity caps the resolved list (default 3)', () => {
  const items = ['a', 'b', 'c', 'd', 'e'].map((m) => ({
    metric: m, label: m.toUpperCase(), is_focus: false,
    continuity: cont({ status: 'resolved', prev_firing: true }),
  }))
  const s = summarizeContinuity(items)
  assert.equal(s.resolved.length, 3)
})

test('summarizeContinuity focus carries ONLY machinery-free fields (client-egress safe)', () => {
  const items = [{
    metric: 'leads', label: 'Leads', is_focus: true,
    continuity: cont({ status: 'new', firing_today: true, streak: 1, delta_today: -80, delta_prev: -40 }),
  }]
  const s = summarizeContinuity(items)
  assert.deepEqual(Object.keys(s.focus).sort(), ['label', 'metric', 'since_back', 'status', 'streak', 'streak_capped', 'trend'])
  for (const k of ['delta_today', 'delta_prev', 'z', 'baseline', 'reliability_label', 'accuracy_label', 'memory_used']) {
    assert.ok(!(k in s.focus), `focus must not leak ${k}`)
  }
})

test('summarizeContinuity is total on empty / garbage', () => {
  for (const v of [[], null, undefined, 'x']) {
    let s
    assert.doesNotThrow(() => { s = summarizeContinuity(v) })
    assert.deepEqual(s, { focus: null, resolved: [], new_count: 0, persisting_count: 0, escalating_count: 0 })
  }
})

// ===========================================================================
// narrateContinuity — focus suffix clause (audience-split, grounded)
// ===========================================================================

test('narrateContinuity falls silent when not firing today', () => {
  assert.equal(narrateContinuity(cont({ firing_today: false })), '')
  assert.equal(narrateContinuity(null), '')
})

test('narrateContinuity new', () => {
  const c = cont({ status: 'new', firing_today: true, streak: 1 })
  assert.equal(narrateContinuity(c, { audience: 'agency' }), 'New this morning.')
  assert.equal(narrateContinuity(c, { audience: 'client' }), 'This is new this morning.')
})

test('narrateContinuity persisting — agency uses ordinal "Nth morning running"', () => {
  const steady = cont({ status: 'persisting', firing_today: true, streak: 3, trend: 'steady' })
  assert.equal(narrateContinuity(steady, { audience: 'agency' }), '3rd morning running.')
  const worse = cont({ status: 'persisting', firing_today: true, streak: 3, trend: 'worsening' })
  assert.equal(narrateContinuity(worse, { audience: 'agency' }), '3rd morning running — and worsening.')
  const ease = cont({ status: 'persisting', firing_today: true, streak: 2, trend: 'easing' })
  assert.equal(narrateContinuity(ease, { audience: 'agency' }), '2nd morning running, though easing.')
})

test('narrateContinuity persisting — client stays warm and plain-language', () => {
  const worse = cont({ status: 'persisting', firing_today: true, streak: 3, trend: 'worsening' })
  assert.equal(narrateContinuity(worse, { audience: 'client' }), "We've been tracking this for 3 days, and it hasn't turned around yet.")
  const ease = cont({ status: 'persisting', firing_today: true, streak: 2, trend: 'easing' })
  assert.equal(narrateContinuity(ease, { audience: 'client' }), "We've been tracking this for 2 days — it's starting to settle.")
  const steady = cont({ status: 'persisting', firing_today: true, streak: 4, trend: 'steady' })
  assert.equal(narrateContinuity(steady, { audience: 'client' }), "We've been tracking this for 4 days now.")
})

test('narrateContinuity capped streak says "at least"', () => {
  const c = cont({ status: 'persisting', firing_today: true, streak: 3, streak_capped: true, trend: 'steady' })
  assert.equal(narrateContinuity(c, { audience: 'agency' }), 'at least 3rd morning running.')
})

test('narrateContinuity defaults to the agency voice', () => {
  const c = cont({ status: 'new', firing_today: true, streak: 1 })
  assert.equal(narrateContinuity(c), 'New this morning.')
})

// ===========================================================================
// narrateResolved — overnight wins (client never names peers)
// ===========================================================================

test('narrateResolved is silent when nothing cleared', () => {
  assert.equal(narrateResolved([]), '')
  assert.equal(narrateResolved(null), '')
})

test('narrateResolved agency lists the cleared metrics', () => {
  assert.equal(narrateResolved([{ metric: 'leads', label: 'Leads' }], { audience: 'agency' }), 'Resolved since yesterday: leads.')
  assert.equal(
    narrateResolved([{ metric: 'leads', label: 'Leads' }, { metric: 'revenue', label: 'Revenue' }], { audience: 'agency' }),
    'Resolved since yesterday: leads, revenue.'
  )
})

test('narrateResolved client names only its own metric, warmly', () => {
  assert.equal(
    narrateResolved([{ metric: 'revenue', label: 'Revenue' }], { audience: 'client' }),
    'Good news — your revenue alert from yesterday has settled back into your normal range.'
  )
  assert.equal(
    narrateResolved([{ metric: 'a', label: 'A' }, { metric: 'b', label: 'B' }], { audience: 'client' }),
    "Good news — 2 of yesterday's alerts have already settled back to normal."
  )
})

// ===========================================================================
// ordinal — streak phrasing helper
// ===========================================================================

test('ordinal handles units, the 11–13 teens exception, and rollovers', () => {
  assert.equal(ordinal(1), '1st')
  assert.equal(ordinal(2), '2nd')
  assert.equal(ordinal(3), '3rd')
  assert.equal(ordinal(4), '4th')
  assert.equal(ordinal(11), '11th')
  assert.equal(ordinal(12), '12th')
  assert.equal(ordinal(13), '13th')
  assert.equal(ordinal(21), '21st')
  assert.equal(ordinal(22), '22nd')
  assert.equal(ordinal(23), '23rd')
})

// ===========================================================================
// exported defaults
// ===========================================================================

test('module exports sane defaults', () => {
  assert.equal(DEFAULT_MEMORY, 7)
  assert.equal(DEFAULT_DEADBAND_PCT, 10)
})
