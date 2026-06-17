'use strict'

// ============================================================
// lib/contribution.js — intel-v6 (5): WHICH CLIENT moved the number.
//
// attribution.js answers "which LEVER moved" (revenue ≡ spend × roas, jobs ≡
// leads × close_rate) — the decomposition WITHIN a metric. This module answers
// the complementary question an agency asks of its whole book: "the portfolio's
// revenue rose $24k — WHO drove it?" For the additive metrics that answer is
// exact arithmetic, no model:
//
//   an additive metric's agency total is a SUM over clients
//     revenue = Σ projected_revenue   leads = Σ raw_leads
//     jobs    = Σ closed_won          spend = Σ (ads + lsa + meta)
//   so the period-over-period change decomposes EXACTLY into per-client deltas
//     Δtotal = Σ (clientᵢ_to − clientᵢ_from)
//
// Each client's signed share of the move is Δclientᵢ / Δtotal, and the shares
// sum to exactly 1 — the same accounting as attribution.js's log-space shares,
// but here in plain linear space because the metric is additive. "Revenue rose
// $24k" becomes "Acme drove +$18k (75% of the rise), Globex +$9k, and Initech
// offset −$3k" — every number individually true and traceable to a stored row.
//
// RATIOS ARE NOT ADDITIVE. roas/cpl/close_rate are ratios of sums, so a client's
// "share" of a ratio change is not a clean sum — that "why" is the DRIVER
// decomposition (attribution.js), not this one. We gate to the four additive
// metrics and return null for the rest; the caller simply omits the per-client
// "why" (and may offer the driver one instead).
//
// Pure functions only — no DB, no clock, no LLM — exactly like attribution.js,
// selftune.js, forecast.js. Never throws. A total that didn't really move yields
// null (nothing to attribute, and dividing by a ~0 denominator would explode the
// shares). Unlike the log-space driver decomposition, additive math is defined at
// zero and for negative deltas, so a missing or zero client is a legitimate 0
// contribution — never a reason to bail.
//
// EXACT RECONCILIATION. The caller fetches per-client rows through the same
// scope-safe compile path as everything else, which caps at a LIMIT. To stay exact
// regardless of that cap (or of a client present in only one window), the caller
// may pass the authoritative agency totals (totalFrom/totalTo — the very
// single-figure numbers the answer already showed); any gap between those and the
// summed rows becomes an explicit `unattributed` remainder, so named + others +
// unattributed always reconcile to the true Δtotal and the shares still sum to 1.
// No silent truncation.
// ============================================================

// The metrics whose agency total is a SUM over clients (see METRICS exprs in
// ask.js). Order is presentation order — volume, then spend.
const ADDITIVE = new Set(['revenue', 'leads', 'jobs', 'spend'])

// Below this |Δtotal| the figure is effectively flat: nothing to attribute, and
// each share's denominator would be ~0. Treat as "no meaningful move" → null.
// (Same epsilon attribution.js uses to decide a composite "actually moved".)
const MOVE_EPS = 1e-9

const isAdditive      = (m) => ADDITIVE.has(m)
const additiveMetrics = () => [...ADDITIVE]

const r1  = (n) => Math.round((Number(n) || 0) * 10) / 10
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)   // additive: garbage → 0

// Build { key → { label, value } } from a rows array. A row may carry
// { key, label, value } or the { bucket, value } shape compileQuery emits for
// group_by:'client' (there `bucket` is the client name, doubling as key + label).
// Last write wins on a duplicate key (the grouped query emits one row per client,
// so dups don't occur — defensive only).
function indexRows(rows) {
  const m = new Map()
  if (!Array.isArray(rows)) return m
  for (const r of rows) {
    if (!r) continue
    const key = r.key != null ? String(r.key)
              : r.bucket != null ? String(r.bucket)
              : r.label != null ? String(r.label) : null
    if (key == null) continue
    const label = r.label != null ? String(r.label)
                : r.bucket != null ? String(r.bucket) : key
    m.set(key, { label, value: num(r.value) })
  }
  return m
}

/**
 * contributionBreakdown(metric, from, to, opts)
 *   metric : an ADDITIVE metric key — 'revenue' | 'leads' | 'jobs' | 'spend'
 *   from   : per-client figures at the BASELINE window — [{ key?, bucket?, label?, value }]
 *   to     : per-client figures at the CURRENT  window — same shape
 *   opts.limit      : max NAMED contributors before the rest fold into `others`
 *                     (default 4; clamped 1..10)
 *   opts.totalFrom  : authoritative agency baseline total (optional — for exact
 *   opts.totalTo    : authoritative agency current  total    reconciliation; see header)
 *
 * Returns null unless `metric` is additive and the (authoritative) total actually
 * moved. Otherwise:
 *   {
 *     metric, direction: 'up' | 'down',
 *     total_from, total_to, total_delta,
 *     pct,                       // 100·(to/from − 1), rounded 1dp; null on a 0 baseline
 *     contributors: [ { key, label, from, to, delta, share, share_pct }, … ],  // ranked, signed; Σ share = 1
 *     lead,                      // the most-aligned named contributor (same fields), or null
 *     others:       { count, from, to, delta, share, share_pct } | null,       // folded tail
 *     unattributed: { from, to, delta, share, share_pct } | null,              // reconciliation remainder
 *   }
 *
 * `share` is SIGNED and the parts (named + others + unattributed) sum to exactly
 * 1: a client that moved OPPOSITE the total carries a negative share — it cushioned
 * the move rather than caused it. `share_pct` is the rounded convenience; because
 * each is rounded independently the integers may total 99 or 101, so a surface that
 * needs a clean split should lead with `lead`.
 */
function contributionBreakdown(metric, from, to, opts = {}) {
  if (!ADDITIVE.has(metric)) return null

  const fromMap = indexRows(from)
  const toMap   = indexRows(to)

  const summedFrom = [...fromMap.values()].reduce((s, e) => s + e.value, 0)
  const summedTo   = [...toMap.values()].reduce((s, e) => s + e.value, 0)

  const totalFrom = Number.isFinite(Number(opts.totalFrom)) ? Number(opts.totalFrom) : summedFrom
  const totalTo   = Number.isFinite(Number(opts.totalTo))   ? Number(opts.totalTo)   : summedTo
  const totalDelta = totalTo - totalFrom
  if (Math.abs(totalDelta) < MOVE_EPS) return null   // didn't move → nothing to attribute

  const limit = Math.min(10, Math.max(1, Math.trunc(Number(opts.limit)) || 4))

  // Per-client deltas over the UNION of clients present in either window. A client
  // missing from one side contributes 0 there (additive: a legitimate value — a new
  // client rose from 0, a churned one fell to 0).
  const ents = []
  for (const key of new Set([...fromMap.keys(), ...toMap.keys()])) {
    const f = fromMap.get(key)
    const t = toMap.get(key)
    const fv = f ? f.value : 0
    const tv = t ? t.value : 0
    const label = (t && t.label) || (f && f.label) || key
    ents.push({ key, label, from: fv, to: tv, delta: tv - fv })
  }

  // share is SIGNED; the parts sum to exactly 1. +0 normalises a −0 (0/negative).
  const share = (d) => d / totalDelta + 0
  const pctOf = (d) => Math.round(100 * share(d)) || 0
  const withShare = (e) => ({ ...e, share: share(e.delta), share_pct: pctOf(e.delta) })

  // Rank by magnitude of move (|delta| ≡ |share| since totalDelta is constant),
  // tie-broken by label for a deterministic order.
  ents.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))

  const named = ents.slice(0, limit)
  const tail  = ents.slice(limit)

  const contributors = named.map(withShare)

  // lead = the most ALIGNED named contributor (max signed share — the client most
  // responsible for, and moving WITH, the change). Null when even the best headline
  // mover moved against the total (share ≤ 0): the move came from the long tail, so
  // there is no single client to name.
  const leadCand = contributors.reduce((best, e) => (e.share > best.share ? e : best), contributors[0])
  const lead = leadCand && leadCand.share > 0 ? leadCand : null

  let others = null
  if (tail.length) {
    const f = tail.reduce((s, e) => s + e.from, 0)
    const t = tail.reduce((s, e) => s + e.to, 0)
    const d = t - f
    others = { count: tail.length, from: f, to: t, delta: d, share: share(d), share_pct: pctOf(d) }
  }

  // Any gap between the authoritative totals and the summed rows (a LIMIT-capped
  // client query, or rows the caller deliberately withheld) is surfaced — never
  // silently dropped — so the parts reconcile to the true Δtotal.
  let unattributed = null
  const remFrom = totalFrom - summedFrom
  const remTo   = totalTo - summedTo
  if (Math.abs(remFrom) > MOVE_EPS || Math.abs(remTo) > MOVE_EPS) {
    const d = remTo - remFrom
    unattributed = { from: remFrom, to: remTo, delta: d, share: share(d), share_pct: pctOf(d) }
  }

  return {
    metric,
    direction: totalDelta > 0 ? 'up' : 'down',
    total_from: totalFrom,
    total_to: totalTo,
    total_delta: totalDelta,
    pct: totalFrom !== 0 ? r1(100 * (totalTo / totalFrom - 1)) : null,
    contributors,
    lead,
    others,
    unattributed,
  }
}

const cap = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : '')

/**
 * narrateContribution(result, opts) — one grounded sentence from a breakdown.
 *
 * GROUNDED BY CONSTRUCTION: every number it emits is read straight from `result`
 * and formatted by the injected `opts.fmt(value) → string` (so this module stays
 * unit-agnostic — the caller passes v => formatValue(v, metric)). `opts.noun` is
 * the metric's spoken noun (default: the metric key). Never throws; '' on no input.
 */
function narrateContribution(result, opts = {}) {
  if (!result) return ''
  const fmt  = typeof opts.fmt === 'function' ? opts.fmt : (v) => String(v)
  const noun = opts.noun || result.metric
  const verb = result.direction === 'up' ? 'rose' : 'fell'
  const pctTxt = result.pct == null ? '' : ` (${result.direction === 'up' ? '+' : '−'}${Math.abs(result.pct)}%)`
  const signed = (d) => (d >= 0 ? '+' : '−') + fmt(Math.abs(d))

  let s = `${cap(noun)} ${verb} ${fmt(Math.abs(result.total_delta))}${pctTxt}.`

  if (result.lead) {
    s += ` ${result.lead.label} drove the most — ${signed(result.lead.delta)} (${Math.abs(result.lead.share_pct)}% of the change)`
    const more = result.contributors.filter((c) => c.key !== result.lead.key).slice(0, 2)
    if (more.length) s += `; ${more.map((c) => `${c.label} ${signed(c.delta)}`).join(', ')}`
    s += '.'
  } else {
    // The headline movers were all cushions, or the move came from the long tail —
    // name the biggest movers without crowning one as the driver.
    const top = result.contributors.slice(0, 2)
    if (top.length) s += ` Biggest moves: ${top.map((c) => `${c.label} ${signed(c.delta)}`).join(', ')}.`
  }
  return s
}

module.exports = { contributionBreakdown, narrateContribution, isAdditive, additiveMetrics, ADDITIVE }
