'use strict'
// test/scopeNowcastMateriality.test.js — intel-v14 D9 (step a).
// Proves assessNowcastMateriality reads each polarity-bearing projection's |pct| and answers the
// question D8 (coherence) cannot: is the projected move BIG ENOUGH to act on? D8 classifies the basket
// by POLARITY (unified/divergent/deteriorating); D9 tempers that by MAGNITUDE so a technically-
// divergent-but-trivial basket (revenue +30% over cost-per-lead +1%) reads "marginal divergence", not
// the same alarm as a revenue +8% / cpl +25% basket. The level keys on the DECISIVE side (the
// worsening one if any, else the gaining one), so the chip and the note can never contradict.
// Byte-stable, leak-safe, fail-safe.
const { test } = require('node:test')
const assert = require('node:assert/strict')

const { assessNowcastMateriality } = require('../lib/scopeNowcastMateriality')

// ── fixtures ─────────────────────────────────────────────────────────────────
// pct is the SIGNED percent move (×100) from current→projected; the module sizes on its absolute
// value. CPL going UP is improving:false — rising cost worsens even though the raw direction is 'up'.
const P_REV_UP_BIG = { metric: 'revenue', metric_label: 'Revenue', direction: 'up', improving: true, current: 10000, projected: 13000, pct: 30 }
const P_REV_UP_MID = { metric: 'revenue', metric_label: 'Revenue', direction: 'up', improving: true, current: 10000, projected: 10800, pct: 8 }
const P_REV_UP_SMALL = { metric: 'revenue', metric_label: 'Revenue', direction: 'up', improving: true, current: 10000, projected: 10400, pct: 4 }
const P_CPL_UP_BIG = { metric: 'cpl', metric_label: 'Cost per Lead', direction: 'up', improving: false, current: 50, projected: 62.5, pct: 25 }
const P_CPL_UP_SMALL = { metric: 'cpl', metric_label: 'Cost per Lead', direction: 'up', improving: false, current: 50, projected: 50.5, pct: 1 }
const P_LEADS_DOWN_BIG = { metric: 'leads', metric_label: 'Leads', direction: 'down', improving: false, current: 40, projected: 36, pct: -10 }
const P_NULL = { metric: 'sessions', metric_label: 'Sessions', direction: 'up', improving: null, current: 900, projected: 1200, pct: 33 }

const nc = (projections) => ({ status: 'projected', projections })

// Tokens that must NEVER appear in a materiality payload (it embeds no tenant identity).
const LEAK_TOKENS = ['client_id', 'clientId', 'scopeClientId', 'tenant', 'locationId', 'location_id', 'accountId', '"7"']

// ── 1. material gain — a single big favorable move ────────────────────────────
test('D9: a single material favorable projection is a material gain', () => {
  const m = assessNowcastMateriality(nc([P_REV_UP_BIG]))
  assert.equal(m.status, 'assessed')
  assert.equal(m.reason, null)
  assert.equal(m.level, 'material')
  assert.equal(m.threshold, 5)
  assert.equal(m.assessedCount, 1)
  assert.equal(m.materialCount, 1)
  assert.equal(m.marginalCount, 0)
  assert.deepEqual(m.biggestMove, { metric: 'revenue', label: 'Revenue', direction: 'up', improving: true, pct: 30, absPct: 30 })
  assert.deepEqual(m.biggestFavorable, m.biggestMove)
  assert.equal(m.biggestAdverse, null)
  assert.deepEqual(m.decisive, m.biggestMove)
  assert.equal(m.note, 'Revenue is projected up ~30% — a material gain.')
  assert.deepEqual(m.meta, { basis: 'projection-magnitude' })
})

// ── 2. marginal shift — a single small favorable move ─────────────────────────
test('D9: a single sub-threshold favorable projection is a marginal shift', () => {
  const m = assessNowcastMateriality(nc([P_REV_UP_SMALL]))
  assert.equal(m.level, 'marginal')
  assert.equal(m.assessedCount, 1)
  assert.equal(m.materialCount, 0)
  assert.equal(m.marginalCount, 1)
  assert.equal(m.note, 'Revenue is projected to move under ~5% — a marginal shift.')
})

// ── 3. marginal divergence — the crying-wolf guard (the heart of D9) ──────────
// Revenue projected up ~30%, cost per lead projected up ~1%. D8 calls this "divergent". D9 sizes the
// DECISIVE (worsening) side at ~1% → 'marginal', so the chip says Marginal and the note explains the
// divergence is a hairline — NOT the same caution as a real material divergence. materialCount is 1
// (revenue cleared the bar) yet level is marginal: they answer different questions, by design.
test('D9: a big gain over a hairline worsening reads as a marginal divergence, not material', () => {
  const m = assessNowcastMateriality(nc([P_REV_UP_BIG, P_CPL_UP_SMALL]))
  assert.equal(m.status, 'assessed')
  assert.equal(m.level, 'marginal')
  assert.equal(m.assessedCount, 2)
  assert.equal(m.materialCount, 1) // revenue +30 cleared the bar...
  assert.equal(m.marginalCount, 1) // ...but cost per lead +1 did not
  assert.deepEqual(m.biggestFavorable, { metric: 'revenue', label: 'Revenue', direction: 'up', improving: true, pct: 30, absPct: 30 })
  assert.deepEqual(m.biggestAdverse, { metric: 'cpl', label: 'Cost per Lead', direction: 'up', improving: false, pct: 1, absPct: 1 })
  assert.deepEqual(m.decisive, m.biggestAdverse) // the worsening side sets the level
  assert.equal(m.note, 'Revenue is projected up ~30%, while the worsening side stays under ~5% — the divergence is marginal.')
})

// ── 4. material divergence — a modest gain over a real worsening ──────────────
test('D9: a material worsening alongside a gain is a material divergence', () => {
  const m = assessNowcastMateriality(nc([P_REV_UP_MID, P_CPL_UP_BIG]))
  assert.equal(m.level, 'material')
  assert.equal(m.assessedCount, 2)
  assert.equal(m.materialCount, 2)
  assert.equal(m.biggestMove.metric, 'cpl') // 25 > 8
  assert.equal(m.biggestAdverse.absPct, 25)
  assert.equal(m.biggestFavorable.absPct, 8)
  assert.deepEqual(m.decisive, m.biggestAdverse)
  assert.equal(m.note, 'Cost per Lead is projected to worsen ~25% — a material divergence, not noise.')
})

// ── 5. material slide — every move adverse and the worst is material ──────────
test('D9: an all-adverse basket with a material worst move is a material slide', () => {
  const m = assessNowcastMateriality(nc([P_CPL_UP_BIG, P_LEADS_DOWN_BIG]))
  assert.equal(m.level, 'material')
  assert.equal(m.assessedCount, 2)
  assert.equal(m.materialCount, 2)
  assert.equal(m.biggestFavorable, null)
  assert.equal(m.biggestAdverse.metric, 'cpl') // 25 > 10
  assert.deepEqual(m.decisive, m.biggestAdverse)
  assert.equal(m.note, 'Cost per Lead is projected to worsen ~25% — a material slide.')
})

// ── 6. marginal multi — both sides under the threshold ───────────────────────
test('D9: when every move is sub-threshold the basket is marginal across the board', () => {
  const m = assessNowcastMateriality(nc([P_REV_UP_SMALL, P_CPL_UP_SMALL]))
  assert.equal(m.level, 'marginal')
  assert.equal(m.materialCount, 0)
  assert.equal(m.marginalCount, 2)
  assert.equal(m.note, 'Every projected move is under ~5% — the shifts are marginal, not yet decisive.')
})

// ── 7. null-polarity projections are excluded entirely ───────────────────────
test('D9: projections with a null improving flag carry no magnitude', () => {
  const m = assessNowcastMateriality(nc([P_NULL]))
  assert.equal(m.status, 'none')
  assert.equal(m.reason, 'no-magnitude')
  assert.equal(m.level, 'indeterminate')
  assert.equal(m.assessedCount, 0)
  assert.equal(m.biggestMove, null)
  assert.equal(m.decisive, null)
  assert.equal(m.note, null)
  // a null-polarity metric beside one real favorable → only the real one is sized.
  const m2 = assessNowcastMateriality(nc([P_NULL, P_REV_UP_BIG]))
  assert.equal(m2.assessedCount, 1)
  assert.equal(m2.level, 'material')
})

// ── 8. no defensible base — polarity-bearing but unmeasurable ────────────────
test('D9: a polarity-bearing projection with no finite magnitude is excluded', () => {
  // current 0 and no pct → pctChange is undefined → excluded → nothing left to size.
  const m = assessNowcastMateriality(nc([{ metric: 'revenue', metric_label: 'Revenue', direction: 'up', improving: true, current: 0, projected: 5 }]))
  assert.equal(m.status, 'none')
  assert.equal(m.reason, 'no-magnitude')
})

// ── 9. pct fallback — recompute from current/projected when pct is absent ────
test('D9: magnitude falls back to the canonical pctChange formula when pct is omitted', () => {
  const m = assessNowcastMateriality(nc([{ metric: 'revenue', metric_label: 'Revenue', direction: 'up', improving: true, current: 10000, projected: 13000 }]))
  assert.equal(m.status, 'assessed')
  assert.equal(m.biggestMove.pct, 30) // (13000-10000)/10000*100
  assert.equal(m.biggestMove.absPct, 30)
  assert.equal(m.level, 'material')
  assert.equal(m.note, 'Revenue is projected up ~30% — a material gain.')
})

// ── 10. dedup — a duplicated metric id is sized once, first wins ──────────────
test('D9: a duplicate metric id is deduped, the more salient entry kept', () => {
  const dupRevenue = { metric: 'revenue', metric_label: 'Revenue', direction: 'up', improving: true, current: 10000, projected: 99999, pct: 99 }
  const m = assessNowcastMateriality(nc([P_REV_UP_BIG, dupRevenue, P_CPL_UP_BIG]))
  assert.equal(m.assessedCount, 2)
  assert.equal(m.biggestFavorable.absPct, 30) // the first revenue (30), not the duplicate (99)
  assert.equal(m.biggestFavorable.pct, 30)
  assert.equal(m.level, 'material') // cpl 25 is decisive
})

// ── 11. threshold override — opts.materialPct moves the cutoff ───────────────
test('D9: opts.materialPct overrides the cutoff; invalid values fall back to 5', () => {
  const high = assessNowcastMateriality(nc([P_REV_UP_BIG]), { materialPct: 40 })
  assert.equal(high.threshold, 40)
  assert.equal(high.level, 'marginal') // 30 < 40
  assert.equal(high.materialCount, 0)
  assert.equal(high.note, 'Revenue is projected to move under ~40% — a marginal shift.')
  // non-positive / non-numeric overrides are ignored — the default 5 stands.
  for (const bad of [{ materialPct: 0 }, { materialPct: -3 }, { materialPct: 'x' }, {}]) {
    const m = assessNowcastMateriality(nc([P_REV_UP_BIG]), bad)
    assert.equal(m.threshold, 5)
    assert.equal(m.level, 'material')
  }
})

// ── 12. leak-safety — the payload embeds no tenant identity ──────────────────
test('D9: materiality payload carries no tenant identifiers', () => {
  const results = [
    assessNowcastMateriality(nc([P_REV_UP_BIG])),
    assessNowcastMateriality(nc([P_REV_UP_BIG, P_CPL_UP_SMALL])),
    assessNowcastMateriality(nc([P_REV_UP_MID, P_CPL_UP_BIG])),
    assessNowcastMateriality(nc([P_CPL_UP_BIG, P_LEADS_DOWN_BIG])),
  ]
  for (const m of results) {
    const json = JSON.stringify(m)
    for (const tok of LEAK_TOKENS) assert.ok(!json.includes(tok), `must not leak ${tok}`)
  }
})

// ── 13. purity / determinism — same inputs, byte-identical output ────────────
test('D9: deterministic — identical inputs yield deep-equal results', () => {
  assert.deepEqual(
    assessNowcastMateriality(nc([P_REV_UP_BIG, P_CPL_UP_SMALL])),
    assessNowcastMateriality(nc([P_REV_UP_BIG, P_CPL_UP_SMALL])),
  )
  assert.deepEqual(
    assessNowcastMateriality(nc([P_REV_UP_MID, P_CPL_UP_BIG])),
    assessNowcastMateriality(nc([P_REV_UP_MID, P_CPL_UP_BIG])),
  )
})

// ── 14. fail-safe — junk in, { status:'none' } out, never throws ─────────────
test('D9: malformed inputs degrade to status none without throwing', () => {
  assert.equal(assessNowcastMateriality(null).status, 'none')
  assert.equal(assessNowcastMateriality(undefined).status, 'none')
  assert.equal(assessNowcastMateriality({}).status, 'none')
  assert.equal(assessNowcastMateriality(42).status, 'none')
  // status projected but projections is not an array → empty basket → no-magnitude.
  assert.equal(assessNowcastMateriality({ status: 'projected', projections: 'nope' }).reason, 'no-magnitude')
  // entries missing a metric id are skipped, not fatal.
  const m = assessNowcastMateriality(nc([{ improving: true, pct: 9 }, P_REV_UP_BIG, P_CPL_UP_BIG]))
  assert.equal(m.assessedCount, 2)
})

// ── 15. no projected nowcast — nothing to assess ─────────────────────────────
test('D9: status none with reason no-nowcast when there is no projection', () => {
  assert.equal(assessNowcastMateriality({ status: 'none' }).reason, 'no-nowcast')
  assert.equal(assessNowcastMateriality({ status: 'insufficient' }).reason, 'no-nowcast')
  assert.equal(assessNowcastMateriality({ status: 'trending' }).reason, 'no-nowcast')
})

// ── 16. direction sanitation — an invalid raw direction becomes null ─────────
test('D9: an out-of-domain direction is sanitized to null on the move entry', () => {
  const m = assessNowcastMateriality(nc([{ metric: 'revenue', metric_label: 'Revenue', direction: 'sideways', improving: true, current: 10000, projected: 13000, pct: 30 }]))
  assert.equal(m.biggestMove.direction, null)
  assert.equal(m.level, 'material')
})

// ── 17. label fallback — projection without a label falls to the metric id ───
test('D9: the note falls back to the bare metric id when a projection omits its label', () => {
  const m = assessNowcastMateriality(nc([{ metric: 'revenue', direction: 'up', improving: true, current: 10000, projected: 13000, pct: 30 }]))
  assert.equal(m.biggestMove.label, 'revenue')
  assert.equal(m.note, 'Revenue is projected up ~30% — a material gain.') // cap() title-cases the sentence head
})
