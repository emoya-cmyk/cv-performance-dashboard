'use strict'

// ============================================================
// lib/trajectory.js — predictive early-warning (PURE).
//
// health.js answers "where does this client stand TODAY?" — one number, one band,
// for every client this morning. Useful, but still a rear-view mirror: by the time a
// client shows up red in the triage roster they are ALREADY in trouble, and the agency
// is doing damage control instead of prevention. Every other layer in the intelligence
// stack is likewise reactive — it detects, explains, clusters, and confirms-recovery
// AFTER the move has landed. The one thing the tool cannot yet do is the thing a sharp
// account lead does in their head: look at a client who is still green but sliding, and
// say "this one's going to be a problem in three weeks — let's get ahead of it." This
// module is that instinct, made mechanical.
//
// It takes a client's SERIES of past health scores (oldest → newest, one per sweep) and
// projects it FORWARD with forecast.js's Holt model — the same trend-aware projection,
// with the same honest prediction band the rest of the layer already trusts. Then it
// asks health.js's own band cutoffs a single question: does this trajectory fall THROUGH
// the floor of the band the client sits in today, and if so, when? A client at 78 (watch)
// drifting down two points a week crosses 65 into at_risk in about seven weeks — and this
// flags it now, while there is still runway to act.
//
// HONESTY BY CONSTRUCTION — two crossing strengths, straight off the calibrated band:
//   • 'likely'   — the CENTRAL forecast itself falls below the floor within the horizon.
//                  A real projected downgrade.
//   • 'possible' — only the pessimistic EDGE of the prediction band reaches the floor; the
//                  central path holds. A "watch this" hedge, not a claim.
// `eta` is when the central line crosses; `eta_worst` (≤ eta) is the earliest the band
// allows — the honest "as soon as." confidence comes from the fit's own MAPE and stays
// null until there is enough history to trust it, so a two-week-old client never gets a
// false-precision warning. Clients already in the worst band have no lower floor to fall
// through, so they never generate a crossing — they belong to the triage roster, not here.
//
// The self-improving property is inherited, not added: forecast.js's bands are tuned by
// the forecast-vs-actual loop (intel-v2 #4 / selftune.js), so as the projections get
// sharper, these warnings get sharper with them — no constants here to hand-tune. Same
// scores always yield the same verdict.
//
// AGENCY-grade by nature (a cross-client roster), but unlike systemic.js it leaks nothing
// cross-tenant: each client's verdict is computed from that client's OWN scores alone, so a
// single verdict is equally safe to show a client about themselves ("you're trending toward
// watch") — only the ranked ROSTER is agency-only, same as health's triage list.
//
// PURE: scores in, verdict out. No DB, no clock, no network, no LLM, no mutation of inputs
// (matching forecast.js / health.js / systemic.js). Empty/garbage/too-thin history → a quiet
// no-op verdict (method 'none', crossing null), never a throw — a brand-new client renders
// exactly as it did before this layer existed.
// ============================================================

const { finite }                   = require('./baselines')
const { forecast }                 = require('./forecast')
const { healthBand, BAND_CUTOFFS } = require('./health')

const DEFAULT_HORIZON = 4    // sweeps ahead to project (matches forecast.js's default)
const DEFAULT_FLAT    = 0.5  // |per-step score slope| below this reads as 'stable', not a trend
const MIN_HISTORY     = 3    // fewer scores than this → no crossing claim (a line needs a past)
const MIN_FIT_N       = 4    // fewer → confidence stays null (MAPE on 2–3 points overstates trust)

// band → its lower floor score, e.g. watch → 65. Falling below your band's floor is a downgrade.
const CUTOFF_BY_BAND = BAND_CUTOFFS.reduce((m, c) => { m[c.band] = c.min; return m }, {})

// strength ordering for the roster: a real (central) crossing outranks a band-only maybe.
const KIND_RANK = { likely: 2, possible: 1 }

const clamp    = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n)
const num      = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d }
const score100 = (x) => clamp(Math.round(x), 0, 100)   // a projected health score lives in [0,100]

// A client we cannot project yet (no usable history): a flat, crossing-free verdict that
// renders as "nothing to warn about," carrying whatever single score we do have.
function noVerdict(current, n) {
  const cur = Number.isFinite(current) ? score100(current) : null
  const band = cur == null ? null : healthBand(cur)
  return {
    method: 'none', n: n || 0,
    current: cur, current_band: band,
    trend: 0, direction: 'stable',
    projected: cur, projected_band: band, projected_lo: cur, projected_hi: cur,
    band_change: 'none', crossing: null, confidence: null,
    horizon: 0,
  }
}

// ── classify ONE client's trajectory ──────────────────────────────────────────────
// scores: that client's chronological (oldest → newest) health scores, one per sweep.
// opts  : { horizon = 4, flat = 0.5, alpha, beta, z } — alpha/beta/z thread straight into
//          forecast.js (omit to inherit its tuned defaults).
// Returns, for ANY input:
//   method        : 'holt' | 'naive' | 'none' (the projection model that fit)
//   n             : count of usable scores
//   current       : latest score (0–100) — the actual last observation, not the smoothed level
//   current_band  : healthy | watch | at_risk | critical
//   trend         : per-step score slope (negative = worsening), rounded to 2dp
//   direction     : 'improving' | 'stable' | 'deteriorating'
//   projected     : score at the horizon (central point, clamped 0–100)
//   projected_band, projected_lo, projected_hi : band + prediction interval at the horizon
//   band_change   : 'downgrade' | 'upgrade' | 'none' (current band vs projected band)
//   crossing      : null, or { from_band, to_band, cutoff, eta, eta_worst, kind } — the
//                   downgrade through the current band's floor, if the projection makes one
//   confidence    : fit trust ∈ [0,1] from MAPE, or null until MIN_FIT_N scores exist
//   horizon       : the projection length used
function classifyTrajectory(scores, opts = {}) {
  const horizon = Math.max(1, Math.trunc(num(opts.horizon, DEFAULT_HORIZON)))
  const flat    = Math.max(0, num(opts.flat, DEFAULT_FLAT))

  const v = finite(scores)
  const n = v.length
  const current = n ? v[n - 1] : NaN

  const fc = forecast(v, { horizon, alpha: opts.alpha, beta: opts.beta, z: opts.z })
  if (fc.method === 'none' || !fc.points.length) return noVerdict(current, n)

  const curBand = healthBand(score100(current))
  const trend = fc.trend
  const direction = trend <= -flat ? 'deteriorating' : trend >= flat ? 'improving' : 'stable'

  // the projected path, clamped into score space; the band is forecast.js's own (resStd·√h).
  const path = fc.points.map((p) => ({
    step: p.step, point: score100(p.point), lo: score100(p.lo), hi: score100(p.hi),
  }))
  const end = path[path.length - 1]
  const projectedBand = healthBand(end.point)
  const band_change =
    CUTOFF_BY_BAND[projectedBand] < CUTOFF_BY_BAND[curBand] ? 'downgrade'
      : CUTOFF_BY_BAND[projectedBand] > CUTOFF_BY_BAND[curBand] ? 'upgrade'
        : 'none'

  // fit trust from the model's own one-step error, gated on enough history to mean anything.
  const confidence =
    (Number.isFinite(fc.mape) && n >= MIN_FIT_N) ? clamp(1 - fc.mape / 100, 0, 1) : null

  // the crossing: does the trajectory fall THROUGH the floor of the band it sits in today?
  // A client already in the lowest band (floor 0) has no lower floor — no crossing by design.
  let crossing = null
  const floor = CUTOFF_BY_BAND[curBand]
  if (n >= MIN_HISTORY && Number.isFinite(floor) && floor > 0) {
    let eta = null       // central line crosses the floor (a real projected downgrade)
    let etaWorst = null  // pessimistic band edge reaches the floor (the earliest plausible)
    for (const p of path) {
      if (eta == null && p.point < floor) eta = p.step
      if (etaWorst == null && p.lo < floor) etaWorst = p.step
      if (eta != null && etaWorst != null) break
    }
    if (eta != null || etaWorst != null) {
      crossing = {
        from_band: curBand,
        to_band:   healthBand(floor - 1),
        cutoff:    floor,
        eta,                                            // null when only the band threatens
        eta_worst: etaWorst != null ? etaWorst : eta,   // ≤ eta (lo ≤ point ⇒ crosses no later)
        kind:      eta != null ? 'likely' : 'possible',
      }
    }
  }

  return {
    method: fc.method, n,
    current: score100(current), current_band: curBand,
    trend: Math.round(trend * 100) / 100, direction,
    projected: end.point, projected_band: projectedBand, projected_lo: end.lo, projected_hi: end.hi,
    band_change, crossing, confidence, horizon,
  }
}

// ── rank a portfolio's early warnings ─────────────────────────────────────────────
// groups: [{ client_id, client_name, scores:[...] }] — each client with its health-score
// history. Returns ONLY the clients heading for trouble — a projected downgrade crossing,
// not already improving out of it, not already in the worst band — each enriched with its
// full trajectory verdict, ordered most-urgent-first:
//   real (central) crossings before band-only maybes → soonest plausible crossing →
//   worst destination (lower floor) → steepest decline → lowest current score → name.
// This is the "heading for trouble" roster; an empty array means nobody is sliding. Pure.
function rankEarlyWarnings(groups, opts = {}) {
  const list = Array.isArray(groups) ? groups : []
  const out = []
  for (const g of list) {
    if (!g) continue
    const v = classifyTrajectory(g.scores, opts)
    if (!v.crossing) continue                  // no projected downgrade → not a warning
    if (v.direction === 'improving') continue  // getting better; a wide band is not a warning
    if (v.current_band === 'critical') continue // already at the floor — that's the triage roster's job
    out.push({
      client_id:   g.client_id != null ? g.client_id : null,
      client_name: g.client_name != null ? g.client_name : null,
      ...v,
    })
  }
  out.sort((a, b) =>
    (KIND_RANK[b.crossing.kind] - KIND_RANK[a.crossing.kind]) || // real crossings first
    (a.crossing.eta_worst - b.crossing.eta_worst) ||             // soonest plausible first
    (a.crossing.cutoff - b.crossing.cutoff) ||                   // lower floor = worse destination
    (a.trend - b.trend) ||                                       // steeper decline first
    (a.current - b.current) ||                                   // lower current score first
    String(a.client_name || '').localeCompare(String(b.client_name || '')))
  return out
}

module.exports = {
  classifyTrajectory,
  rankEarlyWarnings,
  // constants (exported for tests + any consumer that wants the same thresholds)
  DEFAULT_HORIZON,
  DEFAULT_FLAT,
  MIN_HISTORY,
  MIN_FIT_N,
}
