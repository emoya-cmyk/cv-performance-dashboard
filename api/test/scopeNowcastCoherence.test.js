'use strict'
// test/scopeNowcastCoherence.test.js — intel-v14 D8 (step a).
// Proves assessNowcastCoherence reads the WHOLE projection vector and classifies the basket as
// unified / divergent / deteriorating by POLARITY (the `improving` flag, not raw direction) — so a
// headline metric projected up while unit economics project worse is caught (divergent), the case
// every lead-centric lens D1–D7 is structurally blind to. Byte-stable, leak-safe, fail-safe.
const { test } = require('node:test')
const assert = require('node:assert/strict')

const { assessNowcastCoherence } = require('../lib/scopeNowcastCoherence')

// ── fixtures ─────────────────────────────────────────────────────────────────
// Polarity is carried by `improving` (true = good for this metric, false = bad). Note that CPL going
// UP is improving:false — rising cost is a worsening move even though the raw direction is 'up'.
const P_REV_UP_GOOD = { metric: 'revenue', metric_label: 'Revenue', direction: 'up', improving: true, projected: 13000, horizon: 1 }
const P_LEADS_UP_GOOD = { metric: 'leads', metric_label: 'Leads', direction: 'up', improving: true, projected: 42, horizon: 1 }
const P_CONV_UP_GOOD = { metric: 'conversion_rate', metric_label: 'Conversion Rate', direction: 'up', improving: true, projected: 0.3, horizon: 1 }
const P_CPL_UP_BAD = { metric: 'cpl', metric_label: 'Cost per Lead', direction: 'up', improving: false, projected: 55, horizon: 1 }
const P_LEADS_DOWN_BAD = { metric: 'leads', metric_label: 'Leads', direction: 'down', improving: false, projected: 12, horizon: 1 }
const P_NULL_A = { metric: 'sessions', metric_label: 'Sessions', direction: 'up', improving: null, projected: 900, horizon: 1 }
const P_NULL_B = { metric: 'impressions', metric_label: 'Impressions', direction: 'down', improving: null, projected: 5000, horizon: 1 }

const nc = (projections) => ({ status: 'projected', projections })

// Tokens that must NEVER appear in a coherence payload (it embeds no tenant identity).
const LEAK_TOKENS = ['client_id', 'clientId', 'scopeClientId', 'tenant', 'locationId', 'location_id', 'accountId', '"7"']

// ── 1. unified — every assessed metric improving (2-metric phrasing) ──────────
test('D8: unified when all polarity-bearing projections are improving', () => {
  const c = assessNowcastCoherence(nc([P_REV_UP_GOOD, P_LEADS_UP_GOOD]))
  assert.equal(c.status, 'assessed')
  assert.equal(c.reason, null)
  assert.equal(c.level, 'unified')
  assert.equal(c.favorableCount, 2)
  assert.equal(c.unfavorableCount, 0)
  assert.equal(c.assessedCount, 2)
  assert.deepEqual(c.leadFavorable, { metric: 'revenue', label: 'Revenue', direction: 'up' })
  assert.equal(c.leadUnfavorable, null)
  assert.deepEqual(c.favorable, [
    { metric: 'revenue', label: 'Revenue', direction: 'up' },
    { metric: 'leads', label: 'Leads', direction: 'up' },
  ])
  assert.deepEqual(c.unfavorable, [])
  assert.equal(c.note, 'Both revenue and leads are projected to improve — the basket is moving as one.')
  assert.deepEqual(c.meta, { basis: 'projection-vector' })
})

// ── 2. unified — 3+ improving uses the count phrasing ─────────────────────────
test('D8: unified with three improving metrics uses the all-N phrasing', () => {
  const c = assessNowcastCoherence(nc([P_REV_UP_GOOD, P_LEADS_UP_GOOD, P_CONV_UP_GOOD]))
  assert.equal(c.level, 'unified')
  assert.equal(c.favorableCount, 3)
  assert.equal(c.note, 'All 3 projected metrics are moving the right way — the trajectory is coherent.')
})

// ── 3. deteriorating — every assessed metric worsening (2-metric phrasing) ────
test('D8: deteriorating when all polarity-bearing projections are worsening', () => {
  const c = assessNowcastCoherence(nc([P_CPL_UP_BAD, P_LEADS_DOWN_BAD]))
  assert.equal(c.status, 'assessed')
  assert.equal(c.level, 'deteriorating')
  assert.equal(c.favorableCount, 0)
  assert.equal(c.unfavorableCount, 2)
  assert.equal(c.leadFavorable, null)
  assert.deepEqual(c.leadUnfavorable, { metric: 'cpl', label: 'Cost per Lead', direction: 'up' })
  assert.equal(c.note, 'Both cost per lead and leads are projected to worsen — the slide is broad, not isolated.')
})

// ── 4. divergent — the vanity-metric catch (1-v-1, no count clause) ───────────
// Revenue projected up looks triumphant; cost per lead projected up (worsening) underneath it means
// the gain isn't clean. NO lead-centric lens (D1–D7) can see this — it needs the whole vector.
test('D8: divergent names the tension when improving and worsening metrics coexist', () => {
  const c = assessNowcastCoherence(nc([P_REV_UP_GOOD, P_CPL_UP_BAD]))
  assert.equal(c.status, 'assessed')
  assert.equal(c.level, 'divergent')
  assert.equal(c.favorableCount, 1)
  assert.equal(c.unfavorableCount, 1)
  assert.equal(c.assessedCount, 2)
  assert.deepEqual(c.leadFavorable, { metric: 'revenue', label: 'Revenue', direction: 'up' })
  assert.deepEqual(c.leadUnfavorable, { metric: 'cpl', label: 'Cost per Lead', direction: 'up' })
  assert.equal(c.note, "Revenue is projected to improve, but cost per lead is projected to worsen — the gain isn't clean.")
})

// ── 5. divergent — more than 1-v-1 appends the count clause ───────────────────
test('D8: divergent appends a count clause when the split is not a clean one-v-one', () => {
  const c = assessNowcastCoherence(nc([P_REV_UP_GOOD, P_LEADS_UP_GOOD, P_CPL_UP_BAD]))
  assert.equal(c.level, 'divergent')
  assert.equal(c.favorableCount, 2)
  assert.equal(c.unfavorableCount, 1)
  assert.equal(c.note, "Revenue is projected to improve, but cost per lead is projected to worsen — the gain isn't clean (2 improving, 1 worsening).")
})

// ── 6. not-enough-metrics — a single polarity-bearing projection ──────────────
test('D8: status none when only one metric carries a polarity (nothing to cohere with)', () => {
  const c = assessNowcastCoherence(nc([P_REV_UP_GOOD]))
  assert.equal(c.status, 'none')
  assert.equal(c.reason, 'not-enough-metrics')
  assert.equal(c.level, 'indeterminate')
  assert.equal(c.note, null)
  assert.deepEqual(c.favorable, [])
  assert.deepEqual(c.unfavorable, [])
})

// ── 7. null-polarity projections are excluded entirely ───────────────────────
test('D8: projections with a null improving flag never count toward coherence', () => {
  // Two metrics, but neither has a defensible polarity → assessedCount 0 → none.
  const c = assessNowcastCoherence(nc([P_NULL_A, P_NULL_B]))
  assert.equal(c.status, 'none')
  assert.equal(c.reason, 'not-enough-metrics')
  assert.equal(c.assessedCount, 0)
  // One real favorable + one null → only ONE polarity-bearing metric → none. The none() envelope
  // reports a clean zero count (it asserts "nothing was assessed", not the partial internal tally).
  const c2 = assessNowcastCoherence(nc([P_REV_UP_GOOD, P_NULL_A]))
  assert.equal(c2.status, 'none')
  assert.equal(c2.reason, 'not-enough-metrics')
  assert.equal(c2.assessedCount, 0)
})

// ── 8. no projected nowcast — nothing to assess ──────────────────────────────
test('D8: status none with reason no-nowcast when there is no projection', () => {
  assert.equal(assessNowcastCoherence({ status: 'none' }).reason, 'no-nowcast')
  assert.equal(assessNowcastCoherence({ status: 'insufficient' }).reason, 'no-nowcast')
})

// ── 9. dedup — a duplicated metric id is counted once ────────────────────────
test('D8: a duplicate metric id is deduped, counted once in salience order', () => {
  const dupRevenue = { metric: 'revenue', metric_label: 'Revenue', direction: 'up', improving: true, projected: 99999 }
  const c = assessNowcastCoherence(nc([P_REV_UP_GOOD, dupRevenue, P_CPL_UP_BAD]))
  assert.equal(c.favorableCount, 1)
  assert.equal(c.unfavorableCount, 1)
  assert.equal(c.assessedCount, 2)
  assert.equal(c.level, 'divergent')
})

// ── 10. leak-safety — the payload embeds no tenant identity ──────────────────
test('D8: coherence payload carries no tenant identifiers', () => {
  const results = [
    assessNowcastCoherence(nc([P_REV_UP_GOOD, P_LEADS_UP_GOOD])),
    assessNowcastCoherence(nc([P_REV_UP_GOOD, P_CPL_UP_BAD])),
    assessNowcastCoherence(nc([P_CPL_UP_BAD, P_LEADS_DOWN_BAD])),
  ]
  for (const c of results) {
    const json = JSON.stringify(c)
    for (const tok of LEAK_TOKENS) assert.ok(!json.includes(tok), `must not leak ${tok}`)
  }
})

// ── 11. purity / determinism — same inputs, byte-identical output ────────────
test('D8: deterministic — identical inputs yield deep-equal results', () => {
  assert.deepEqual(
    assessNowcastCoherence(nc([P_REV_UP_GOOD, P_CPL_UP_BAD])),
    assessNowcastCoherence(nc([P_REV_UP_GOOD, P_CPL_UP_BAD])),
  )
  assert.deepEqual(
    assessNowcastCoherence(nc([P_REV_UP_GOOD, P_LEADS_UP_GOOD, P_CONV_UP_GOOD])),
    assessNowcastCoherence(nc([P_REV_UP_GOOD, P_LEADS_UP_GOOD, P_CONV_UP_GOOD])),
  )
})

// ── 12. fail-safe — junk in, { status:'none' } out, never throws ─────────────
test('D8: malformed inputs degrade to status none without throwing', () => {
  assert.equal(assessNowcastCoherence(null).status, 'none')
  assert.equal(assessNowcastCoherence(undefined).status, 'none')
  assert.equal(assessNowcastCoherence({}).status, 'none')
  assert.equal(assessNowcastCoherence(42).status, 'none')
  // status projected but projections is not an array → empty basket → not-enough-metrics.
  assert.equal(assessNowcastCoherence({ status: 'projected', projections: 'nope' }).reason, 'not-enough-metrics')
  // entries missing a metric id are skipped, not fatal.
  const c = assessNowcastCoherence(nc([{ improving: true }, P_REV_UP_GOOD, P_CPL_UP_BAD]))
  assert.equal(c.assessedCount, 2)
})

// ── 13. label fallback — projection without a label falls to the metric id ───
test('D8: rosters fall back to the bare metric id when a projection omits its label', () => {
  const c = assessNowcastCoherence(nc([
    { metric: 'revenue', direction: 'up', improving: true },
    { metric: 'cpl', direction: 'up', improving: false },
  ]))
  assert.equal(c.leadFavorable.label, 'revenue')
  assert.equal(c.leadUnfavorable.label, 'cpl')
  assert.equal(c.note, "revenue is projected to improve, but cpl is projected to worsen — the gain isn't clean.")
})

// ── 14. direction sanitation — an invalid raw direction becomes null ─────────
test('D8: an out-of-domain direction is sanitized to null on the roster entry', () => {
  const c = assessNowcastCoherence(nc([
    { metric: 'revenue', metric_label: 'Revenue', direction: 'sideways', improving: true },
    { metric: 'cpl', metric_label: 'Cost per Lead', direction: 'up', improving: false },
  ]))
  assert.equal(c.leadFavorable.direction, null)
  assert.equal(c.leadUnfavorable.direction, 'up')
})
