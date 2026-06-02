'use strict'

// ============================================================
// lib/efficacy.js — the action→OUTCOME learning loop (pure).
//
// The intelligence stack already does two halves of a loop it never closes:
//   • recommendedAction() (lib/insights.js) attaches a PLAY to every adverse finding —
//     "trend down on leads → don't wait, pull the lever now."
//   • classifyRecovery() (lib/outcomes.js) later PROVES, by arithmetic, whether that
//     finding's problem actually cleared — the metric returned to baseline, the dark
//     channel reconnected (RECOVERED) — or merely aged out unproven (LAPSED).
// Nothing connects them. So the engine recommends the same play forever with no idea
// whether it WORKS, and the wins it does measure teach it nothing about which advice
// to trust. This module is the missing wire: it reads the recovery verdicts back
// against the play that was recommended and learns, per play archetype, how often the
// underlying problem CLEARS and how FAST — so a recommendation can finally carry its
// own track record ("this play has cleared the problem 78% of the time, 14 of 18,
// usually within 9 days") and the feed can lean on the plays that earn it. THAT is the
// self-improving the product goal keeps asking for, pushed one level past precision.js:
// precision learns what a client ATTENDS to; this learns what actually gets FIXED.
//
// Not a duplicate of precision.js — orthogonal axis, different label source:
//   • precision.js scores ENGAGEMENT (did a human ack/resolve vs ignore) per signature
//     → a feed-rank multiplier. "Does this audience care?"
//   • efficacy.js scores measured RECOVERY (did the problem clear, how fast) per play
//     → an annotation on the recommendation. "Does this play work?"
// A finding a client always ignores but that always self-recovers is high-efficacy /
// low-engagement; one they always ack but that never clears is the reverse. Both are
// true and useful, and only measuring both tells them apart.
//
// MEASURED, never opinion. A sample is a finding whose outcome we could COMPUTE:
//   • recovered  → SUCCESS (1) — the play's problem provably cleared.
//   • lapsed / expired → FAILURE (0) — it aged out with no proof of clearing.
//   • acknowledged / resolved with NO recovery proof, or still open → PENDING — a human
//     verdict is engagement, not evidence the metric came back, so it is NOT counted
//     here (precision.js already credits that attention). We only learn from outcomes
//     arithmetic could verify; absence of proof never inflates a play's record.
//
// Statistics — the same Beta-Bernoulli shrinkage discipline precision.js uses (one
// house style for "rate at small n"), plus a Wilson lower bound for ranking:
//   • efficacy = (successes + priorMean·K) / (n + K). Neutral prior at n=0 (a brand-new
//     play reads exactly as the base rate, never 0% or 100% off one case), raw rate as
//     n→∞. priorMean defaults to the pooled base rate across all supplied rows, so a
//     sparse play shrinks toward how plays perform OVERALL, not a blind 0.5.
//   • lower = Wilson 95% lower confidence bound on the success probability. Shrinkage
//     gives the honest point estimate; the lower bound gives a DEFENSIBLE order — 9/10
//     outranks 1/1 because the evidence is deeper — so "most effective plays" can't be
//     topped by a single lucky sample. Ranking is by lower, then efficacy, then n.
//   • median_days = median days-to-recovery among the successes (the "usually within N
//     days" half of the claim). Median, not mean — one slow recovery can't distort it.
//
// PURE: mirrors precision.js / outcomes.js / attribution.js — no DB, no clock, no
// network, no mutation of inputs; rows in, a table out. Never throws; degenerate input
// yields an empty table and a neutral base rate (a behavioral no-op). The engine (1b)
// owns the I/O: it reads historical findings carrying their recovery verdict + a
// days-to-recovery it stamps at expiry, feeds them here, and persists/serves the table.
// ============================================================

// ── tuning constants (the only "magic numbers", all in one place) ────────────
const PRIOR_WEIGHT = 6      // pseudo-count: ~6 decided samples before data outweighs the prior (matches precision.js)
const PRIOR_MEAN   = 0.5    // neutral fallback when there's no history to pool a base rate from
const Z            = 1.96   // 95% normal quantile for the Wilson lower bound
const EFF_LOW      = 0.40   // efficacy < 0.40 → "low" band (this play rarely clears the problem)
const EFF_HIGH     = 0.66   // efficacy ≥ 0.66 → "high" band (this play reliably clears it)
const NOTE_MIN_N   = 4      // efficacyNote() stays silent below this many decided samples — never boast off a hunch

// ── tiny helpers ─────────────────────────────────────────────────────────────
const clamp   = (x, lo, hi) => Math.min(hi, Math.max(lo, x))
const clamp01 = x => clamp(x, 0, 1)
const round3  = x => Math.round(Number(x) * 1000) / 1000

// Non-negative integer tally from anything; junk → 0. Counts must never let a stray
// null/NaN poison the arithmetic — it just reads as "no observations."
function countOf(v) {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) && n > 0 ? n : 0
}

// Finite, non-negative day count, else null. A recovery that took a negative or
// non-numeric number of days is unmeasurable and must not enter the median.
function dayOf(v) {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : null
}

// ── recovery outcome → learning label ─────────────────────────────────────────
// A finding becomes an efficacy SAMPLE only once arithmetic could verify its outcome.
// Accepts either an explicit recovery verdict (the shape lib/outcomes.js emits —
// { outcome:'recovered'|'lapsed', recovered }) or the persisted lifecycle `status`,
// so the engine can feed whichever it has on the row:
//   • recovered === true, or outcome/status 'recovered'        → 'success'
//   • outcome/status 'lapsed', or status 'expired'             → 'failure'
//   • anything else (open / acknowledged / resolved-without-   → 'pending' (NOT a sample)
//     proof / unknown)
// `resolved`/`acknowledged` are deliberately PENDING here: a human terminal decision is
// engagement (precision.js's domain), not measured recovery. We only count what we can
// re-measure, so a play's record reflects problems that provably cleared — nothing softer.
function classifyEfficacy(row) {
  const r = row || {}
  if (r.recovered === true) return 'success'
  const v = String(r.outcome != null ? r.outcome : (r.status != null ? r.status : '')).toLowerCase()
  if (v === 'recovered') return 'success'
  if (v === 'lapsed' || v === 'expired') return 'failure'
  return 'pending'
}

// ── play key: the archetype efficacy is learned at ────────────────────────────
// `kind::metric` — the same fields that determine recommendedAction()'s text, so a
// play's learned record lines up exactly with the recommendation a new finding of that
// shape will show. Adverse-only by nature (a win carries no play). Metric-less kinds
// (data_health, coverage_gap) key on `kind::*`. Same granularity precision.js learns at;
// the Beta prior absorbs the sparsity that granularity creates.
function playKey(finding) {
  const f = finding || {}
  return `${f.kind || 'unknown'}::${f.metric || '*'}`
}

// ── tally rows into per-play success/failure counts + recovery days ───────────
// rows: findings carrying { kind, metric, outcome|status|recovered, days_to_recovery }.
// PENDING rows contribute nothing. Returns Map playKey → { kind, metric, successes,
// failures, n, days[] } where n is the DECIDED count (the denominator that earns an
// opinion) and days[] collects the finite recovery durations of the successes only.
function tallyEfficacy(rows) {
  const out = new Map()
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const label = classifyEfficacy(row)
    if (label === 'pending') continue
    const key = playKey(row)
    let e = out.get(key)
    if (!e) {
      e = { kind: (row && row.kind) || 'unknown', metric: (row && row.metric) || null, successes: 0, failures: 0, n: 0, days: [] }
      out.set(key, e)
    }
    if (label === 'success') {
      e.successes++
      const d = dayOf(row && (row.days_to_recovery != null ? row.days_to_recovery : row.daysToRecovery))
      if (d != null) e.days.push(d)
    } else {
      e.failures++
    }
    e.n++
  }
  return out
}

// Raw recovery rate successes/(successes+failures), or null with no decided samples.
function rateOf({ successes, failures } = {}) {
  const s = countOf(successes), f = countOf(failures)
  const n = s + f
  return n ? s / n : null
}

// ── Beta-Bernoulli efficacy (the headline point estimate) ─────────────────────
// Posterior mean of the success probability under a Beta(priorMean·K,(1−priorMean)·K)
// prior: (successes + priorMean·K)/(n + K). Pure shrinkage — neutral prior at n=0, raw
// rate as n→∞. Robust to any input (junk → 0, prior clamped, weight ≥ 0). [0,1], rounded.
function efficacyOf({ successes, failures } = {}, { priorMean = PRIOR_MEAN, priorWeight = PRIOR_WEIGHT } = {}) {
  const s  = countOf(successes), f = countOf(failures)
  const n  = s + f
  const pm = clamp01(Number.isFinite(priorMean) ? priorMean : PRIOR_MEAN)
  const k  = Math.max(0, Number.isFinite(priorWeight) ? priorWeight : PRIOR_WEIGHT)
  if (n + k === 0) return round3(pm)
  return round3(clamp01((s + pm * k) / (n + k)))
}

// ── Wilson score lower bound (the ranking key) ────────────────────────────────
// 95% lower confidence bound on the true success probability. Rewards depth of
// evidence: 9/10 ranks above 1/1 because the interval is tighter. n=0 → 0 (no evidence,
// no credit). Pure, total, [0,1], rounded. This is what "most effective plays" sorts by
// so a single lucky recovery can never crown a play.
function wilsonLower({ successes, failures } = {}) {
  const s = countOf(successes), f = countOf(failures)
  const n = s + f
  if (n === 0) return 0
  const p      = s / n
  const z2     = Z * Z
  const denom  = 1 + z2 / n
  const center = p + z2 / (2 * n)
  const margin = Z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)
  return round3(clamp01((center - margin) / denom))
}

// Median of a numeric list (ascending; mean of the two middles when even). Returns null
// for an empty list. Median, not mean, so one straggler recovery can't skew "usually N days."
function medianOf(list) {
  const xs = (Array.isArray(list) ? list : []).filter(d => Number.isFinite(d)).slice().sort((a, b) => a - b)
  if (xs.length === 0) return null
  const mid = Math.floor(xs.length / 2)
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2
}

// efficacy → discrete band for the UI (and quick thresholding).
function bandOf(efficacy) {
  const c = Number(efficacy)
  if (!Number.isFinite(c)) return 'medium'
  if (c < EFF_LOW)  return 'low'
  if (c >= EFF_HIGH) return 'high'
  return 'medium'
}

// ── pooled base rate → a data-driven prior mean ───────────────────────────────
// Pool ALL decided rows into one success rate, to shrink sparse per-play estimates
// toward how plays clear OVERALL rather than a blind 0.5. Returns { mean, n }; mean is
// null (caller uses the default) until there's at least one decided sample.
function baseRateOf(rows) {
  let successes = 0, n = 0
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const label = classifyEfficacy(row)
    if (label === 'pending') continue
    if (label === 'success') successes++
    n++
  }
  return { mean: n ? successes / n : null, n }
}

// ── one-call pipeline: rows → ranked per-play efficacy table ───────────────────
// The convenience the orchestrator calls (mirrors precision.confidenceTable). Tallies
// the rows, derives each play's shrunk efficacy + Wilson lower bound + median recovery
// days + credibility, and returns BOTH a Map (play → record) and a ranked array (most
// effective first), alongside the global base rate it shrank toward. Pass an explicit
// priorMean to shrink toward a fleet rate; omit it to use this row set's own base rate
// (itself falling back to the neutral default with no history). PURE — same rows always
// yield the same table and the same order.
function efficacyTable(rows, { priorMean, priorWeight = PRIOR_WEIGHT } = {}) {
  const base  = baseRateOf(rows)
  const prior = Number.isFinite(priorMean) ? priorMean : (base.mean != null ? base.mean : PRIOR_MEAN)
  const tally = tallyEfficacy(rows)
  const k     = Math.max(0, Number.isFinite(priorWeight) ? priorWeight : PRIOR_WEIGHT)

  const table = new Map()
  for (const [key, t] of tally) {
    const efficacy = efficacyOf(t, { priorMean: prior, priorWeight: k })
    const lower    = wilsonLower(t)
    table.set(key, {
      play: key, kind: t.kind, metric: t.metric,
      n: t.n, successes: t.successes, failures: t.failures,
      recovery_rate: (() => { const r = rateOf(t); return r == null ? null : round3(r) })(),
      efficacy, lower,
      credibility: round3(t.n / (t.n + k)),     // how much the estimate has earned over the prior, [0,1)
      median_days: medianOf(t.days),
      band: bandOf(efficacy),
    })
  }

  // Ranked view: deepest-evidence success first. Tie-breaks are total so the order is
  // deterministic — lower bound, then point estimate, then sample size, then key.
  const ranked = [...table.values()].sort((a, b) =>
    b.lower - a.lower || b.efficacy - a.efficacy || b.n - a.n || a.play.localeCompare(b.play)
  ).map((r, i) => ({ ...r, rank: i + 1 }))
  for (const r of ranked) table.get(r.play).rank = r.rank   // mirror rank back into the Map records

  return { table, ranked, base: { rate: base.mean == null ? null : round3(base.mean), n: base.n, prior: round3(prior) } }
}

// ── per-finding annotation: a recommendation's own track record ───────────────
// Given a finding (or a play key) and a built table, return a short, grounded sentence
// the surfaces can append to the recommended action — or null when the play hasn't
// earned enough evidence to boast (n < NOTE_MIN_N) or isn't in the table at all. Every
// number printed comes straight from the record; nothing is computed here. Stays silent
// rather than guess — an unproven play simply shows its recommendation with no claim.
function efficacyNote(findingOrKey, table) {
  if (!table) return null
  const key = typeof findingOrKey === 'string' ? findingOrKey : playKey(findingOrKey)
  const rec = table instanceof Map ? table.get(key) : (table.table instanceof Map ? table.table.get(key) : null)
  if (!rec || countOf(rec.n) < NOTE_MIN_N) return null
  const pct  = Math.round(clamp01(rec.efficacy) * 100)
  const days = rec.median_days
  const when = days != null
    ? `, usually within ${days === 1 ? 'a day' : `${round3(days)} days`}`
    : ''
  return {
    text: `This play has cleared the problem ${pct}% of the time (${rec.successes} of ${rec.n})${when}.`,
    pct, successes: rec.successes, n: rec.n, median_days: days, band: rec.band,
  }
}

module.exports = {
  classifyEfficacy, playKey, tallyEfficacy, rateOf,
  efficacyOf, wilsonLower, medianOf, bandOf, baseRateOf,
  efficacyTable, efficacyNote,
  // constants (exported for tests + any consumer that wants the same thresholds)
  PRIOR_WEIGHT, PRIOR_MEAN, Z, EFF_LOW, EFF_HIGH, NOTE_MIN_N,
}
