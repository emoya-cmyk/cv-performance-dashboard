'use strict'

// Tests for lib/pulseDiagnose.js — the "why" behind an intra-week pulse. Contract:
//   • it answers WHY a composite flow metric (revenue/jobs) moved this week by
//     REUSING attribution.attributeChange UNCHANGED, fed TRAILING-WINDOW SUMS of
//     the composite and its drivers instead of weekly totals — so the daily-grain
//     decomposition is the exact same log-space arithmetic the Monday recap uses;
//   • the window math MIRRORS dayPulse: latest = the trailing W-day sum; prior
//     windows step straight back by W, never overlapping the latest (pinned below
//     by a cross-check against dayPulse so the two organs reason over the same
//     weeks); it needs the same minimum prior-window count to speak;
//   • SELF-CONSISTENT BASELINE: the "from" endpoint is read whole from the single
//     prior window whose COMPOSITE sum is closest to the median prior composite sum
//     (the typical recent week) — so the identity holds exactly at "from"; ties
//     keep the MORE RECENT window;
//   • HONEST BY ABSTENTION: a non-composite metric, a series shorter than the
//     window, too few prior windows, a non-positive driver (log undefined), or a
//     composite that didn't really move all yield null — attributeChange's own
//     contract — and the caller simply omits the "why";
//   • narratePulseDiagnosis turns a diagnosis into ONE grounded sentence whose
//     every figure is copied off the decomposition (so it can't disagree with the
//     numbers), takes display labels as a parameter, and falls silent ('') on a
//     null/empty diagnosis;
//   • PURE: a frozen series in is never mutated, and it never throws.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  pulseDiagnose,
  diagnoseComposite,
  narratePulseDiagnosis,
  DEFAULT_WINDOW,
  DEFAULT_MIN_WINDOWS,
} = require('../lib/pulseDiagnose')
const { dayPulse } = require('../lib/dayPulse')

// ── builders ────────────────────────────────────────────────────────────────────────────
// blocks([s0, s1, …]) → a dense daily series of 7-day blocks, oldest first, each
// carrying its whole sum on day 0 and zeros after — identical to dayPulse.test's
// builder. Under the default window the latest trailing window == the last block's
// sum and each prior non-overlapping window == an earlier block's sum, so a test
// names each week's total directly.
const blocks = (sums) => sums.flatMap((s) => [s, 0, 0, 0, 0, 0, 0])

// The flow driver behind each composite (the ratio driver is recovered from the
// two sums, exactly as the module does).
const FLOW = { revenue: 'spend', jobs: 'leads' }

// series(metric, compSums, flowSums) → { [metric]:…, [flow]:… } as weekly blocks.
const series = (metric, compSums, flowSums) => ({
  [metric]:       blocks(compSums),
  [FLOW[metric]]: blocks(flowSums),
})

// Display labels, passed in like narrateDayPulse(label) — the module imports no catalogue.
const LBL = {
  revenue: 'Revenue', jobs: 'Jobs won',
  leads: 'Leads', spend: 'Ad spend', roas: 'ROAS', close_rate: 'Close rate',
}

// ── the four canonical cases: driver / cushion / contributor / tailwind ───────────────────

test('diagnoseComposite: a leads-driven jobs drop names leads, with close rate held', () => {
  // jobs 20→10 (−50%) entirely from leads 40→20; close rate 50→50 held.
  const d = diagnoseComposite(series('jobs', [20, 20, 20, 10], [40, 40, 40, 20]), 'jobs')
  assert.equal(d.metric, 'jobs')
  assert.equal(d.direction, 'down')
  assert.equal(d.pct, -50)
  assert.equal(d.lead, 'leads')
  const leads = d.drivers.find((x) => x.metric === 'leads')
  const close = d.drivers.find((x) => x.metric === 'close_rate')
  assert.equal(leads.pct, -50)
  assert.equal(leads.share_pct, 100)
  assert.equal(close.pct, 0)
  assert.equal(close.share_pct, 0)
  assert.equal(close.share, 0)          // a held driver normalizes −0 → 0
  // window bookkeeping the UI/caller relies on
  assert.equal(d.window, 7)
  assert.equal(d.latest_index, 27)      // 4 blocks × 7 − 1
  assert.equal(d.baseline_index, 20)    // first prior window (all priors equal → most recent)
  assert.equal(d.n_windows, 3)
})

test('diagnoseComposite: a spend-driven revenue drop carries a NEGATIVE share for a cushioning ROAS', () => {
  // revenue 1000→700 (−30%): spend 1000→500 (−50%) drove it; ROAS 1.0→1.4 (+40%)
  // moved OPPOSITE and cushioned. Shares: spend +1.94, roas −0.94 (sum to 1).
  const d = diagnoseComposite(series('revenue', [1000, 1000, 1000, 700], [1000, 1000, 1000, 500]), 'revenue')
  assert.equal(d.direction, 'down')
  assert.equal(d.pct, -30)
  assert.equal(d.lead, 'spend')
  const spend = d.drivers.find((x) => x.metric === 'spend')
  const roas  = d.drivers.find((x) => x.metric === 'roas')
  assert.equal(spend.pct, -50)
  assert.equal(spend.share_pct, 194)
  assert.ok(spend.share > 1)            // dominant aligned driver overshoots to compensate
  assert.equal(roas.pct, 40)
  assert.equal(roas.share_pct, -94)
  assert.ok(roas.share < 0)             // cushioning driver carries a negative share
  // shares sum to exactly 1 (the log identity)
  assert.ok(Math.abs(spend.share + roas.share - 1) < 1e-12)
})

test('diagnoseComposite: a close-rate-led jobs drop still ranks leads as a contributor', () => {
  // jobs 20→8 (−60%): leads 100→80 (−20%) and close rate 20→10 (−50%); close rate leads.
  const d = diagnoseComposite(series('jobs', [20, 20, 20, 8], [100, 100, 100, 80]), 'jobs')
  assert.equal(d.direction, 'down')
  assert.equal(d.pct, -60)
  assert.equal(d.lead, 'close_rate')
  const leads = d.drivers.find((x) => x.metric === 'leads')
  const close = d.drivers.find((x) => x.metric === 'close_rate')
  assert.equal(leads.pct, -20)
  assert.equal(leads.share_pct, 24)
  assert.equal(close.pct, -50)
  assert.equal(close.share_pct, 76)
  assert.ok(leads.share > 0 && close.share > 0)   // both aligned with the drop
})

test('diagnoseComposite: an upside move decomposes identically — a ROAS-led revenue tailwind', () => {
  // revenue 1000→1430 (+43%): spend 1000→1100 (+10%), ROAS 1.0→1.3 (+30%); ROAS leads.
  const d = diagnoseComposite(series('revenue', [1000, 1000, 1000, 1430], [1000, 1000, 1000, 1100]), 'revenue')
  assert.equal(d.direction, 'up')
  assert.equal(d.pct, 43)
  assert.equal(d.lead, 'roas')
  const spend = d.drivers.find((x) => x.metric === 'spend')
  const roas  = d.drivers.find((x) => x.metric === 'roas')
  assert.equal(spend.pct, 10)
  assert.equal(spend.share_pct, 27)
  assert.equal(roas.pct, 30)
  assert.equal(roas.share_pct, 73)
})

// ── self-consistent baseline selection ────────────────────────────────────────────────────

test('diagnoseComposite: baseline "from" is the prior window closest to the median composite sum', () => {
  // prior composite sums (oldest→newest blocks) 900, 1200, 1000 → median 1000;
  // the 1000 window (end 20) is the baseline. Latest drops it to 700 the Case-2 way.
  const d = diagnoseComposite(
    series('revenue', [900, 1200, 1000, 700], [900, 1200, 1000, 500]),
    'revenue',
  )
  assert.equal(d.baseline_index, 20)    // the median-closest prior window, not merely the most recent
  assert.equal(d.latest_index, 27)
  assert.equal(d.pct, -30)
  assert.equal(d.lead, 'spend')
})

test('diagnoseComposite: a tie in distance keeps the MORE RECENT prior window', () => {
  // 4 prior windows, composite sums (most-recent-first) 1000,1200,800,1000 → median 1000;
  // the newest (end 27) and oldest (end 6) are both exactly on target — the newest wins.
  const d = diagnoseComposite(
    series('revenue', [1000, 800, 1200, 1000, 700], [1000, 800, 1200, 1000, 500]),
    'revenue',
  )
  assert.equal(d.baseline_index, 27)    // tie → more recent (strict-less-than never displaces it)
  assert.equal(d.n_windows, 4)
  assert.equal(d.pct, -30)
})

// ── honest abstention ───────────────────────────────────────────────────────────────────

test('diagnoseComposite: a non-composite metric → null', () => {
  assert.equal(diagnoseComposite(series('jobs', [20, 20, 20, 10], [40, 40, 40, 20]), 'leads'), null)
  assert.equal(diagnoseComposite(series('jobs', [20, 20, 20, 10], [40, 40, 40, 20]), 'cpl'), null)
})

test('diagnoseComposite: a zero-flow latest window (log undefined) → null', () => {
  // spend collapses to 0 this week → roas = revenue/0 is non-finite, attributeChange abstains.
  assert.equal(
    diagnoseComposite(series('revenue', [1000, 1000, 1000, 700], [1000, 1000, 1000, 0]), 'revenue'),
    null,
  )
})

test('diagnoseComposite: too few prior windows → null', () => {
  // only 2 prior windows < default minWindows(3)
  assert.equal(diagnoseComposite(series('revenue', [1000, 1000, 700], [1000, 1000, 500]), 'revenue'), null)
})

test('diagnoseComposite: a series shorter than one window → null', () => {
  assert.equal(diagnoseComposite({ revenue: [1, 2, 3], spend: [1, 2, 3] }, 'revenue'), null)
})

test('diagnoseComposite: a composite that did not really move → null', () => {
  // latest window identical to the baseline window → totalLog ≈ 0 → null
  assert.equal(
    diagnoseComposite(series('revenue', [1000, 1000, 1000, 1000], [1000, 1000, 1000, 1000]), 'revenue'),
    null,
  )
})

test('diagnoseComposite: a missing driver series → null', () => {
  assert.equal(diagnoseComposite({ revenue: blocks([1000, 1000, 1000, 700]) }, 'revenue'), null)
  assert.equal(diagnoseComposite(null, 'revenue'), null)
  assert.equal(diagnoseComposite(undefined, 'jobs'), null)
})

// ── the window knob is honored ────────────────────────────────────────────────────────────

test('diagnoseComposite: a custom window changes the trailing and prior windows', () => {
  // 2-day windows: 4 windows of (revenue, spend) → 3 prior + latest. Latest halves revenue
  // via spend with roas held → −50%, spend-led.
  const s = {
    revenue: [10, 10, 10, 10, 10, 10, 5, 5],   // four 2-day sums: 20,20,20,10
    spend:   [10, 10, 10, 10, 10, 10, 5, 5],   // roas = 1 every window
  }
  const d = diagnoseComposite(s, 'revenue', { window: 2 })
  assert.equal(d.window, 2)
  assert.equal(d.pct, -50)
  assert.equal(d.lead, 'spend')
  assert.equal(d.latest_index, 7)
  assert.equal(d.n_windows, 3)
})

test('diagnoseComposite: minWindows is configurable', () => {
  // 2 prior windows: default minWindows(3) abstains, minWindows:2 speaks.
  const s = series('revenue', [1000, 1000, 700], [1000, 1000, 500])
  assert.equal(diagnoseComposite(s, 'revenue'), null)
  assert.equal(diagnoseComposite(s, 'revenue', { minWindows: 2 }).pct, -30)
  assert.equal(DEFAULT_WINDOW, 7)
  assert.equal(DEFAULT_MIN_WINDOWS, 3)
})

// ── pulseDiagnose fan-out ─────────────────────────────────────────────────────────────────

test('pulseDiagnose: returns ONLY the composites that produced a decomposition', () => {
  // revenue moves (decomposes); jobs is flat (abstains) → diagnoses has revenue only.
  const s = {
    ...series('revenue', [1000, 1000, 1000, 700], [1000, 1000, 1000, 500]),
    ...series('jobs',    [20, 20, 20, 20],         [40, 40, 40, 40]),
  }
  const out = pulseDiagnose(s)
  assert.equal(out.window, 7)
  assert.ok(out.diagnoses.revenue)
  assert.equal(out.diagnoses.revenue.lead, 'spend')
  assert.equal(out.diagnoses.jobs, undefined)   // flat → omitted, not null-valued
})

test('pulseDiagnose: both composites can fire at once', () => {
  const s = {
    ...series('revenue', [1000, 1000, 1000, 700], [1000, 1000, 1000, 500]),
    ...series('jobs',    [20, 20, 20, 10],         [40, 40, 40, 20]),
  }
  const out = pulseDiagnose(s)
  assert.equal(out.diagnoses.revenue.lead, 'spend')
  assert.equal(out.diagnoses.jobs.lead, 'leads')
})

test('pulseDiagnose: an empty/garbage series → no diagnoses, never throws', () => {
  assert.deepEqual(pulseDiagnose({}).diagnoses, {})
  assert.deepEqual(pulseDiagnose(null).diagnoses, {})
  assert.deepEqual(pulseDiagnose(undefined).diagnoses, {})
})

// ── narratePulseDiagnosis: one grounded sentence, figures copied off the diagnosis ──────────

test('narratePulseDiagnosis: a held secondary driver reads "held" (agency + client tone)', () => {
  const d = diagnoseComposite(series('jobs', [20, 20, 20, 10], [40, 40, 40, 20]), 'jobs')
  assert.equal(
    narratePulseDiagnosis(d, { labels: LBL, audience: 'agency' }),
    'Jobs won is down 50% — the driver is Leads (down 50%), while Close rate held.',
  )
  assert.equal(
    narratePulseDiagnosis(d, { labels: LBL, audience: 'client' }),
    'Your jobs won is down 50% — the driver is Leads (down 50%), while Close rate held.',
  )
})

test('narratePulseDiagnosis: a cushioning driver reads "actually rose … and softened the drop"', () => {
  const d = diagnoseComposite(series('revenue', [1000, 1000, 1000, 700], [1000, 1000, 1000, 500]), 'revenue')
  assert.equal(
    narratePulseDiagnosis(d, { labels: LBL, audience: 'agency' }),
    'Revenue is down 30% — the driver is Ad spend (down 50%), while ROAS actually rose 40% and softened the drop.',
  )
})

test('narratePulseDiagnosis: a same-direction contributor reads "with … also down"', () => {
  const d = diagnoseComposite(series('jobs', [20, 20, 20, 8], [100, 100, 100, 80]), 'jobs')
  assert.equal(
    narratePulseDiagnosis(d, { labels: LBL, audience: 'agency' }),
    'Jobs won is down 60% — the driver is Close rate (down 50%), with Leads also down 20%.',
  )
})

test('narratePulseDiagnosis: an upside move reads "up …, with … also up" (client tone)', () => {
  const d = diagnoseComposite(series('revenue', [1000, 1000, 1000, 1430], [1000, 1000, 1000, 1100]), 'revenue')
  assert.equal(
    narratePulseDiagnosis(d, { labels: LBL, audience: 'client' }),
    'Your revenue is up 43% — the driver is ROAS (up 30%), with Ad spend also up 10%.',
  )
})

test('narratePulseDiagnosis: a null/empty diagnosis narrates to empty string', () => {
  assert.equal(narratePulseDiagnosis(null, { labels: LBL }), '')
  assert.equal(narratePulseDiagnosis(undefined), '')
  assert.equal(narratePulseDiagnosis({ drivers: [] }, { labels: LBL }), '')
  assert.equal(narratePulseDiagnosis({}, { labels: LBL }), '')
})

test('narratePulseDiagnosis: missing labels fall back to the raw metric keys', () => {
  const d = diagnoseComposite(series('jobs', [20, 20, 20, 10], [40, 40, 40, 20]), 'jobs')
  assert.equal(
    narratePulseDiagnosis(d, { audience: 'agency' }),
    'jobs is down 50% — the driver is leads (down 50%), while close_rate held.',
  )
})

// ── cross-check against dayPulse: the two organs reason over the SAME weeks ─────────────────

test('diagnoseComposite: window enumeration matches dayPulse exactly', () => {
  // The composite series fed to dayPulse is the same revenue array the diagnosis sees;
  // dayPulse's latest window and prior-window count must line up with the diagnosis's
  // latest_index and n_windows, and both must use window 7 — so the "why" describes the
  // very move the pulse flagged.
  const rev = [1000, 1000, 1000, 700]
  const dp = dayPulse(blocks(rev))
  const d  = diagnoseComposite(series('revenue', rev, [1000, 1000, 1000, 500]), 'revenue')
  assert.equal(d.window, dp.window)             // both 7
  assert.equal(d.window, DEFAULT_WINDOW)
  assert.equal(d.latest_index, blocks(rev).length - 1)
  assert.equal(d.n_windows, dp.baseline.n)      // same count of prior non-overlapping windows
})

// ── purity ──────────────────────────────────────────────────────────────────────────────

test('diagnoseComposite: does not mutate its input (a frozen series is safe)', () => {
  const s = series('revenue', [1000, 1000, 1000, 700], [1000, 1000, 1000, 500])
  Object.freeze(s)
  Object.freeze(s.revenue)
  Object.freeze(s.spend)
  const d = diagnoseComposite(s, 'revenue')     // frozen → throws if it writes
  assert.equal(d.pct, -30)
  assert.equal(s.revenue.length, 28)            // untouched
})
