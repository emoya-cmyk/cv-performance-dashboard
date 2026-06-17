'use strict'

// ============================================================
// lib/correlate.js — root-cause linking (PURE).
//
// The engine emits each finding in isolation: a coverage_gap saying "Meta Ads went
// dark 12 days ago" and, separately, an anomaly saying "leads fell 30%." A human
// triaging the portfolio has to connect those two by hand — and almost always does,
// because the second is the VISIBLE SYMPTOM of the first. This module makes that
// connection for them, grounded in arithmetic rather than a hunch.
//
// Given the sweep's findings plus each channel's historical SHARE of every metric
// (computed by the caller from the atomic fact grain, fact_metric), it links a
// downstream adverse metric finding to an upstream dark channel WHEN, and only when,
// all three hold:
//   • the channel is one we are ALREADY flagging dark (it has a coverage_gap this
//     sweep) — we never invent a cause we aren't also telling the operator to fix;
//   • that channel contributed a MATERIAL share (≥ minShare) of the metric that
//     moved — a channel responsible for 2% of leads is not why leads cratered; and
//   • the metric actually FELL (direction 'down') — losing a positive contributor
//     pulls a total DOWN, so the causal story is sign-consistent. A metric that rose
//     is never "explained" by a channel going dark.
// The asserted link is therefore anchored to a real number — "Meta drove ~42% of
// leads and has been dark 12 days" — not a hand-wave. A channel that fed the metric
// nothing, or a metric that climbed, never links.
//
// What it does NOT yet claim: temporal precedence. Both inputs are "current sweep"
// findings, and we gate on materiality + sign, not on "did the gap open before the
// drop." days_dark is surfaced in the annotation so a human still sees "dark 2 days"
// against "down over 6 weeks" and can discount it. Materiality is the load-bearing
// gate; precedence is a future refinement, deliberately left out to keep this pure
// and conservative.
//
// The annotation is structural, never a fabricated metric. The symptom finding gets a
// `caused_by` pointer (which channel, its share, how long dark); the root coverage_gap
// gets an `impacts` list (which metrics it is dragging, worst share first) — its blast
// radius. Both are NESTED objects/arrays under evidence, so they are skipped by every
// surface's scalar `number|string` evidence-chip filter AND by the grounding verifier's
// scalar checks (exactly like evidence.attribution), and they never touch severity,
// score, or direction — ranking is byte-for-byte unchanged.
//
// PURE: findings + shares in, link descriptors out. No DB, no clock, no network, and —
// matching attribution.js — NO mutation of the inputs (the caller stamps the result
// onto evidence, mirroring attachAttribution()). Empty findings, no dark channel, or
// no shares → a hard no-op ({ links: [], impacts: {} }), so a client without the atomic
// grain renders exactly as it did before this layer existed.
// ============================================================

const num = (v, dflt) => { const n = Number(v); return Number.isFinite(n) ? n : dflt }

// Metric-finding kinds whose DOWN move a lost channel can explain. A coverage gap
// degrades what a channel DELIVERS, so the symptom is a drop in an OBSERVED metric —
// an anomaly (sudden) or a trend (sustained). Forecast and pacing are goal-relative
// PROJECTIONS, not observed deliveries, so we never claim a dark channel "caused" them.
const SYMPTOM_KINDS = new Set(['anomaly', 'trend'])

// linkCoverageToImpact(findings, channelShares, opts)
//   findings      : the sweep's finding objects (post-merge, pre-persist). coverage_gap
//                   carries evidence.{channel, channel_label, category, days_dark};
//                   metric findings carry { kind, metric, direction }.
//   channelShares : { [metricKey]: { [channelKey]: share0to1 } } — each channel's
//                   fractional contribution to the metric over the trailing window.
//                   The caller restricts this to ADDITIVE metrics (revenue/leads/jobs/
//                   spend), where a channel's share is well-defined; ratio metrics
//                   (roas/cpl/close_rate) are simply absent here and so never link.
//   opts          : { minShare = 0.15 } — the materiality floor for asserting a link.
//
// Returns { links, impacts }:
//   links   : [ { index, channel, channel_label, category, share, share_pct, days_dark } ]
//             `index` points at the SYMPTOM finding in `findings`; the rest is the
//             caused_by payload (the DOMINANT dark contributor — largest share wins).
//   impacts : { [channelKey]: [ { metric, share_pct } ] } — per dark channel, the
//             metrics it is measurably dragging, worst share first. The blast radius
//             to stamp onto that channel's coverage_gap. A dark channel that drags
//             nothing simply has no entry (no over-claiming).
function linkCoverageToImpact(findings, channelShares, opts = {}) {
  const NONE = { links: [], impacts: {} }
  if (!Array.isArray(findings) || findings.length === 0) return NONE
  const shares = channelShares && typeof channelShares === 'object' ? channelShares : {}
  const minShare = num(opts.minShare, 0.15)

  // The dark channels we are flagging THIS sweep → channel key → its coverage_gap
  // evidence (for labels / days_dark). We only ever point a symptom at one of these,
  // so every asserted cause comes with a reconnect action the operator already sees.
  const dark = new Map()
  for (const f of findings) {
    if (f && f.kind === 'coverage_gap' && f.evidence && f.evidence.channel != null) {
      dark.set(String(f.evidence.channel), f.evidence)
    }
  }
  if (dark.size === 0) return NONE

  const links = []
  const impactsMap = {}   // channelKey -> { metricKey -> share_pct }   (dedup-safe)

  for (let i = 0; i < findings.length; i++) {
    const f = findings[i]
    if (!f || !SYMPTOM_KINDS.has(f.kind) || f.direction !== 'down' || !f.metric) continue
    const perChannel = shares[f.metric]
    if (!perChannel || typeof perChannel !== 'object') continue

    // Among the dark channels that MATERIALLY feed this fallen metric, the dominant
    // lost contributor (largest share) is the one we name as the likely cause. We
    // also record EVERY qualifying dark channel's impact on this metric, so each
    // channel's coverage_gap shows its full blast radius — not just where it "won."
    let best = null
    for (const [chKey, ev] of dark) {
      const share = num(perChannel[chKey], 0)
      if (share < minShare) continue
      const sharePct = Math.round(share * 100)
      const bucket = impactsMap[chKey] || (impactsMap[chKey] = {})
      if (!(f.metric in bucket) || sharePct > bucket[f.metric]) bucket[f.metric] = sharePct
      if (!best || share > best.share) best = { chKey, ev, share }
    }
    if (!best) continue

    links.push({
      index:         i,
      channel:       best.chKey,
      channel_label: best.ev.channel_label || best.chKey,
      category:      best.ev.category || null,
      share:         Math.round(best.share * 100) / 100,   // 0..1, 2dp
      share_pct:     Math.round(best.share * 100),          // integer percent for display
      days_dark:     num(best.ev.days_dark, null),
    })
  }

  // Flatten the blast radius into a deterministic, worst-first list per channel:
  // share_pct desc, then metric name asc (a stable tie-break so order never depends
  // on object-key enumeration order).
  const impacts = {}
  for (const chKey of Object.keys(impactsMap)) {
    impacts[chKey] = Object.entries(impactsMap[chKey])
      .map(([metric, share_pct]) => ({ metric, share_pct }))
      .sort((a, b) => (b.share_pct - a.share_pct) || String(a.metric).localeCompare(String(b.metric)))
  }

  return { links, impacts }
}

module.exports = { linkCoverageToImpact, SYMPTOM_KINDS }
