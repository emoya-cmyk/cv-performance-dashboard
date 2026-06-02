'use strict'

// ============================================================
// lib/systemic.js — cross-client common-cause detection (PURE).
//
// The engine evaluates each client in isolation, so when one upstream event hits the
// whole book — Meta's pixel breaks platform-wide, an iOS update tanks attribution, a
// holiday flattens lead volume everywhere — it surfaces as N independent per-client
// findings: eleven separate "leads down" anomalies, eleven separate "Meta dark"
// coverage gaps. A human reading the portfolio feed has to notice, by hand, that those
// eleven are ONE story, and answer the only question that changes the response: "is
// this us, or is this the platform?" If it's one client, you audit that account. If
// it's eleven, you don't audit eleven accounts — you check the channel and send one
// note to everyone. This module makes that call for them, grounded in counting rather
// than a hunch.
//
// Given the portfolio's CURRENT active findings (one sweep, every client), it groups
// them by the SIGNAL that would have a common cause — the tuple (channel, metric,
// direction) — and, when the SAME adverse signal independently hit at least `minClients`
// distinct clients (and, if the caller asks, at least `minShare` of the book), it emits
// one systemic signal standing in for the cluster:
//   • coverage_gap  → groups by (channel, ∅, down): "Meta is dark for 9 of your clients."
//   • anomaly/trend → groups by (channel?, metric, direction): "leads are down across
//     14 clients" / "Google CPL is up across 6." Anomaly and trend co-group: the systemic
//     fact is the (channel, metric, direction), not whether each client detected it as a
//     sudden break or a slow slide.
// The signal is anchored to a real count and the actual client set — "9 clients, 38% of
// the book, 4 critical" — never a vibe. Forecast, pacing, benchmark and data_health are
// excluded: projections and peer-relative or internal-quality findings have no shared
// external cause to detect (if everyone is below the peer median, that is arithmetically
// impossible, not systemic).
//
// confidence ∈ [0,1] blends the three things that make a cluster believable as systemic:
// how much of the book it spans (share — the dominant term, because breadth is the truest
// signal), how many clients in absolute terms (count, saturating — three is a pattern, a
// dozen is not meaningfully more certain than ten), and how severe (the fraction of
// affected clients carrying a critical finding). It is monotonic in all three and fully
// determined by the inputs, so the same portfolio always scores identically.
//
// AGENCY-ONLY by contract. A systemic signal names other clients (affected_client_ids)
// and the book-wide share — telling a CLIENT "11 of our other accounts also dropped"
// leaks cross-tenant data, exactly the boundary the anonymized peer benchmark already
// respects. The caller surfaces this on the agency Intelligence view only; it must never
// ride along in a per-client (or shared-link) payload.
//
// PURE: findings in, signal descriptors out. No DB, no clock, no network, and — matching
// correlate.js / attribution.js — NO mutation of the inputs (each signal carries
// member_indices so the caller can stamp a `systemic` pointer onto member findings or mint
// a standalone insight, the caller's choice). Empty/!array input, or no cluster clearing
// the threshold → a hard no-op ({ signals: [] }), so a small or healthy book renders
// exactly as it did before this layer existed.
// ============================================================

const num    = (v, dflt) => { const n = Number(v); return Number.isFinite(n) ? n : dflt }
const round2 = (x) => Math.round(x * 100) / 100
const pct    = (x) => Math.round(x * 100)

// The finding kinds with a plausible SHARED external cause across clients. A coverage_gap
// (a channel stopped delivering) and an observed metric move (anomaly = sudden, trend =
// sustained) can all be one upstream event hitting many accounts at once. Forecast and
// pacing are goal-relative PROJECTIONS; benchmark is peer-RELATIVE (can't be universal by
// construction); data_health is an internal pipeline note — none describe a common cause.
const SYSTEMIC_KINDS = new Set(['anomaly', 'trend', 'coverage_gap'])

// Severities that mark a client as "critically" hit, for the confidence severity term.
const HIGH_SEVERITIES = new Set(['critical', 'severe'])

// Sentinel for an absent dimension in the group key. Channel/metric values are snake_case
// identifiers (meta_ads, leads), never '*', so the key stays unambiguous and readable.
const ANY = '*'

// Confidence weights (sum to 1 → confidence ∈ [0,1]) and the count-saturation knee.
const W_SHARE = 0.45   // breadth across the book — the dominant term
const W_COUNT = 0.35   // absolute reach, saturating at COUNT_SATURATION clients
const W_SEV   = 0.20   // how many affected clients are critical
const COUNT_SATURATION = 8

// detectSystemicSignals(insights, opts)
//   insights : the portfolio's CURRENT active findings (every client, one sweep). Each is
//              { kind, metric, direction, severity, client_id, evidence:{ channel,
//              channel_label } }. "Same window" is guaranteed by the caller passing one
//              sweep's active set — this module does not re-bucket by date.
//   opts     : { portfolioSize, minClients = 3, minShare = 0, countSaturation = 8 }
//              portfolioSize — total ACTIVE clients in the book (preferred: lets share
//                count healthy clients too). Omitted/≤0 → falls back to the number of
//                distinct clients that produced ANY finding (share is then "of clients
//                with findings", a denominator that can only overstate breadth — pass the
//                true size when you have it).
//              minClients — distinct-client floor to call a cluster systemic (default 3:
//                two can be coincidence, three is a pattern).
//              minShare   — optional book-fraction floor (default 0 = off; the count gate
//                is the size-independent primary, share rides along + feeds confidence).
//
// Returns { signals }, sorted confidence desc → affected_count desc → key asc:
//   signals : [ { key, channel, channel_label, metric, direction, kinds[], severity,
//                 affected_count, affected_client_ids[], member_indices[],
//                 share_of_portfolio, share_pct, confidence } ]
//   affected_client_ids / member_indices / kinds are sorted (stable). A book with no
//   qualifying cluster returns { signals: [] }.
function detectSystemicSignals(insights, opts = {}) {
  const NONE = { signals: [] }
  if (!Array.isArray(insights) || insights.length === 0) return NONE

  const minClients = Math.max(1, Math.trunc(num(opts.minClients, 3)))
  const minShare   = num(opts.minShare, 0)
  const satur      = Math.max(1, num(opts.countSaturation, COUNT_SATURATION))

  // Denominator for share: the true active-client count if given, else the distinct set
  // of clients that produced any finding this sweep.
  const allClients = new Set()
  for (const f of insights) {
    if (f && f.client_id != null) allClients.add(String(f.client_id))
  }
  const explicitSize = num(opts.portfolioSize, 0)
  const portfolioSize = explicitSize > 0 ? explicitSize : allClients.size

  // Group eligible findings by (channel, metric, direction).
  const groups = new Map()
  for (let i = 0; i < insights.length; i++) {
    const f = insights[i]
    if (!f || !SYSTEMIC_KINDS.has(f.kind)) continue
    if (f.client_id == null) continue
    const direction = typeof f.direction === 'string' && f.direction ? f.direction : null
    if (!direction) continue   // a systemic claim needs one consistent direction

    const ev      = f.evidence && typeof f.evidence === 'object' ? f.evidence : {}
    const channel = ev.channel != null ? String(ev.channel) : (f.channel != null ? String(f.channel) : null)
    const metric  = f.metric  != null ? String(f.metric)  : null
    if (!channel && !metric) continue   // {*|*|dir} is a meaningless catch-all — skip

    const key = `${channel || ANY}|${metric || ANY}|${direction}`
    let g = groups.get(key)
    if (!g) {
      g = {
        key, channel, metric, direction,
        channel_label: null,
        kinds: new Set(),
        clients: new Set(),
        highSevClients: new Set(),
        memberIdx: [],
      }
      groups.set(key, g)
    }
    const cid = String(f.client_id)
    g.kinds.add(f.kind)
    g.clients.add(cid)
    g.memberIdx.push(i)
    if (HIGH_SEVERITIES.has(f.severity)) g.highSevClients.add(cid)
    if (!g.channel_label) {
      const lbl = ev.channel_label || f.channel_label
      if (lbl) g.channel_label = String(lbl)
    }
  }

  const signals = []
  for (const g of groups.values()) {
    const affectedCount = g.clients.size
    if (affectedCount < minClients) continue

    const share = portfolioSize > 0 ? Math.min(1, affectedCount / portfolioSize) : 0
    if (share < minShare) continue

    // confidence — breadth (share) dominant, absolute reach (saturating) next, severity
    // a booster. Each term ∈ [0,1]; weights sum to 1 → confidence ∈ [0,1].
    const shareScore = share
    const countScore = Math.min(1, affectedCount / satur)
    const sevScore   = affectedCount > 0 ? g.highSevClients.size / affectedCount : 0
    const confidence = round2(W_SHARE * shareScore + W_COUNT * countScore + W_SEV * sevScore)

    signals.push({
      key:                 g.key,
      channel:             g.channel,
      channel_label:       g.channel_label || (g.channel ? g.channel : null),
      metric:              g.metric,
      direction:           g.direction,
      kinds:               Array.from(g.kinds).sort(),
      severity:            g.highSevClients.size > 0 ? 'critical' : 'warning',
      affected_count:      affectedCount,
      affected_client_ids: Array.from(g.clients).sort((a, b) => String(a).localeCompare(String(b))),
      member_indices:      g.memberIdx.slice().sort((a, b) => a - b),
      share_of_portfolio:  portfolioSize > 0 ? round2(share) : null,
      share_pct:           portfolioSize > 0 ? pct(share) : null,
      confidence,
    })
  }

  // Deterministic order: most-believable-and-broadest first, key as the stable tie-break.
  signals.sort((a, b) =>
    (b.confidence - a.confidence) ||
    (b.affected_count - a.affected_count) ||
    String(a.key).localeCompare(String(b.key)))

  return { signals }
}

module.exports = { detectSystemicSignals, SYSTEMIC_KINDS, HIGH_SEVERITIES }
