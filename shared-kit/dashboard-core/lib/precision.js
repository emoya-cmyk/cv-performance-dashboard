'use strict'

// ============================================================
// lib/precision.js — the self-improving PRECISION loop (pure).
//
// selftune.js learns how ACCURATE the engine's projections are and tightens the
// forecast gates. This module learns something different and complementary: how
// USEFUL each KIND of finding has proven to a given client — did a human engage
// with it (ack / resolve), or ignore it until it silently auto-expired? That
// operator signal is captured FOR FREE by the existing insight lifecycle; nobody
// fills in a survey. This module turns it into a per-signature CONFIDENCE the feed
// can rank by, so an alert type a client has repeatedly found worthless sinks, and
// one they act on every time rises — with ZERO threshold tuned by hand. THAT is
// the "self-improving" the product goal calls for: the intelligence layer reads
// its own audience and sharpens itself.
//
// Pure by design (status strings + tallies in, numbers out): no DB, no clock, no
// network. lib/insights.js owns the I/O — it reads the historical insight rows,
// feeds them through here, and persists the result — exactly the split that keeps
// detectFindings and selftune.js unit-testable in isolation. Never throws;
// degenerate input yields the neutral prior (a behavioral no-op).
//
// Statistics — Beta-Bernoulli with shrinkage toward a prior:
//   Each decided finding is a Bernoulli trial: engaged (1) or ignored (0). The raw
//   rate engaged/(engaged+ignored) is wild at small n — one acted-on alert reads as
//   100% "always useful," one ignored as 0% "always noise." So we smooth with a
//   Beta(α,β) prior of pseudo-weight K and let the data outweigh it only as samples
//   accrue: confidence = (engaged + priorMean·K) / (n + K). At n=0 this is EXACTLY
//   priorMean (default 0.5 → neutral), so a brand-new signature — or a feed with no
//   lifecycle history at all — ranks byte-for-byte as it does today. As n→∞ it
//   converges to the raw engaged rate. This is the same shrink-toward-a-prior
//   discipline selftune.js uses for forecast bias correction.
//
// SEPARATION OF CONCERNS: this module only SCORES. It never decides to hide a
// finding. The consumer (the feed ranker) must protect the keystone signals —
// `data_health` (the only thing that keeps the tool self-sustaining) and any
// `critical` severity must never be buried by a low confidence. Demotion is a
// ranking nudge within a severity tier, not a gate.
// ============================================================

// ── tuning constants (the only "magic numbers", all in one place) ────────────
const PRIOR_WEIGHT  = 6     // pseudo-count: ~6 decided samples before data outweighs the prior
const PRIOR_MEAN    = 0.5   // neutral default — a new signature is neither boosted nor buried
const BAND_LOW      = 0.40  // confidence < 0.40 → "low" (this client tends to ignore this kind)
const BAND_HIGH     = 0.66  // confidence ≥ 0.66 → "high" (this client reliably acts on it)
// Feed-weight envelope: confidence [0,1] maps linearly to a score multiplier in
// [WEIGHT_MIN, WEIGHT_MAX]. Centered so the neutral prior (0.5) yields EXACTLY 1.0
// — the no-history path leaves ranking unchanged.
const WEIGHT_MIN    = 0.6
const WEIGHT_MAX    = 1.4

// ── tiny helpers ─────────────────────────────────────────────────────────────
const clamp   = (x, lo, hi) => Math.min(hi, Math.max(lo, x))
const clamp01 = x => clamp(x, 0, 1)
const round3  = x => Math.round(Number(x) * 1000) / 1000

// Non-negative integer count from anything; junk → 0. Counts are tallies, so a
// stray null/NaN must read as "no observations," never poison the arithmetic.
function countOf(v) {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) && n > 0 ? n : 0
}

// ── lifecycle outcome → learning label ────────────────────────────────────────
// A finding becomes a learning SAMPLE only once its lifecycle reaches a verdict:
//   • resolved      → ENGAGED  — a human took a terminal "handled" decision on it.
//   • acknowledged  → ENGAGED  — a human said "I see it, we're on it."
//   • recovered     → ENGAGED  — the engine PROVED the problem cleared (the metric
//       returned to baseline, the channel reconnected; see lib/outcomes.js). This is
//       the strongest true-positive signal there is: a finding so accurate the
//       underlying condition actually got fixed. It must lift the kind's confidence,
//       NEVER sink it — the old "every expiry is ignored" rule scored these wins
//       backwards, slandering the detectors that work. markRecoveries() carves the
//       genuine wins out of the expiry stream so we can credit them here.
//   • expired       → IGNORED  — it auto-closed with no proof of recovery; in the
//       common case nobody acted.
//   • open / other  → PENDING  — still live, no verdict yet → NOT a sample.
// Treating `acknowledged` as engaged (though still active) is deliberate: the human
// ATTENTION is the signal we score, not the eventual resolution. PENDING rows are
// excluded entirely so an open backlog never looks like either success or noise.
function classifyOutcome(status) {
  if (status === 'resolved' || status === 'acknowledged' || status === 'recovered') return 'engaged'
  if (status === 'expired') return 'ignored'
  return 'pending'
}

// ── signature: the unit a client's taste is learned at ────────────────────────
// `kind::metric` — fine enough to tell "revenue forecasts are gold, spend pacing is
// noise" apart, while the Beta prior covers the sparsity that granularity creates.
// A metric-less finding (data_health) keys on `kind::*`.
function signatureKey(finding) {
  const f = finding || {}
  return `${f.kind || 'unknown'}::${f.metric || '*'}`
}

// ── tally a client's historical rows into per-signature outcome counts ────────
// rows: insight rows carrying { kind, metric, status }. PENDING rows contribute
// nothing. Returns Map signature → { kind, metric, engaged, ignored, n } where n is
// the number of DECIDED samples (engaged + ignored) — the denominator that earns
// the right to an opinion.
function tallyOutcomes(rows) {
  const out = new Map()
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const outcome = classifyOutcome(row && row.status)
    if (outcome === 'pending') continue
    const key = signatureKey(row)
    let e = out.get(key)
    if (!e) {
      e = { kind: (row && row.kind) || 'unknown', metric: (row && row.metric) || null, engaged: 0, ignored: 0, n: 0 }
      out.set(key, e)
    }
    if (outcome === 'engaged') e.engaged++
    else                       e.ignored++
    e.n++
  }
  return out
}

// Raw engaged rate engaged/(engaged+ignored), or null when there are no decided
// samples (undefined at zero — caller falls back to the prior).
function rateOf({ engaged, ignored } = {}) {
  const e = countOf(engaged), i = countOf(ignored)
  const n = e + i
  return n ? e / n : null
}

// ── the Beta-Bernoulli confidence ─────────────────────────────────────────────
// Posterior mean of engaged-probability under a Beta(priorMean·K, (1-priorMean)·K)
// prior: (engaged + priorMean·K) / (n + K). Pure shrinkage — neutral prior at n=0,
// raw rate at n→∞. Robust to any input (junk counts → 0, prior clamped to [0,1],
// weight ≥ 0). Returns a number in [0,1], rounded for stable storage/compare.
function confidenceOf({ engaged, ignored } = {}, { priorMean = PRIOR_MEAN, priorWeight = PRIOR_WEIGHT } = {}) {
  const e  = countOf(engaged), i = countOf(ignored)
  const n  = e + i
  const pm = clamp01(Number.isFinite(priorMean) ? priorMean : PRIOR_MEAN)
  const k  = Math.max(0, Number.isFinite(priorWeight) ? priorWeight : PRIOR_WEIGHT)
  if (n + k === 0) return round3(pm)          // no data AND no prior weight → the prior mean itself
  return round3(clamp01((e + pm * k) / (n + k)))
}

// confidence → discrete band for the UI (and quick thresholding).
function bandOf(confidence) {
  const c = Number(confidence)
  if (!Number.isFinite(c)) return 'medium'
  if (c < BAND_LOW)  return 'low'
  if (c >= BAND_HIGH) return 'high'
  return 'medium'
}

// confidence → feed-rank multiplier in [WEIGHT_MIN, WEIGHT_MAX]. The neutral prior
// (0.5) maps to EXACTLY 1.0, so applying this to a score is a no-op until the loop
// has actually learned something. The ranker multiplies a finding's `score` by this
// to nudge low-confidence kinds DOWN and high-confidence kinds UP — within, never
// across, a severity tier.
function weightFor(confidence) {
  const c = clamp01(Number.isFinite(Number(confidence)) ? Number(confidence) : PRIOR_MEAN)
  return round3(WEIGHT_MIN + (WEIGHT_MAX - WEIGHT_MIN) * c)
}

// ── fleet-wide engaged rate → a data-driven prior mean ────────────────────────
// Pool ALL of a client's (or the whole fleet's) decided rows into one base rate, to
// shrink sparse per-signature estimates toward how this audience behaves overall
// rather than a hard 0.5. Returns { mean, n }; mean is null (caller uses the
// default) until there's at least one decided sample.
function baseRateOf(rows) {
  let engaged = 0, n = 0
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const outcome = classifyOutcome(row && row.status)
    if (outcome === 'pending') continue
    if (outcome === 'engaged') engaged++
    n++
  }
  return { mean: n ? engaged / n : null, n }
}

// ── one-call pipeline: rows → per-signature confidence table ──────────────────
// The convenience the orchestrator calls (mirrors selftune's scoreboardOf →
// calibrationFor pipeline). Tallies the rows, derives each signature's confidence
// shrunk toward the supplied/computed prior, and tags a band + feed weight. Pass an
// explicit `priorMean` to shrink toward a fleet rate; omit it to use this row set's
// own base rate; that itself falls back to the neutral default when there's no
// history. Returns Map signature → { kind, metric, engaged, ignored, n, confidence,
// band, weight }. PURE — same rows always yield the same table.
function confidenceTable(rows, { priorMean, priorWeight = PRIOR_WEIGHT } = {}) {
  const prior = Number.isFinite(priorMean) ? priorMean : (baseRateOf(rows).mean ?? PRIOR_MEAN)
  const tally = tallyOutcomes(rows)
  const table = new Map()
  for (const [key, t] of tally) {
    const confidence = confidenceOf(t, { priorMean: prior, priorWeight })
    table.set(key, {
      kind: t.kind, metric: t.metric,
      engaged: t.engaged, ignored: t.ignored, n: t.n,
      confidence, band: bandOf(confidence), weight: weightFor(confidence),
    })
  }
  return table
}

module.exports = {
  classifyOutcome, signatureKey, tallyOutcomes, rateOf,
  confidenceOf, bandOf, weightFor, baseRateOf, confidenceTable,
  // constants (exported for tests + any consumer that wants the same thresholds)
  PRIOR_WEIGHT, PRIOR_MEAN, BAND_LOW, BAND_HIGH, WEIGHT_MIN, WEIGHT_MAX,
}
