'use strict'
// ============================================================
// briefEngagementLearning — intel-v9 layer 19a: close the engagement loop.
// ------------------------------------------------------------
// Layer 18 (briefEngagement + briefEngagementEngine) is the FIRST OUTWARD loop:
// the human reader grades the morning brief 👍/👎, and the agency sees the
// aggregate (helpful_rate, label, trend, a per-client board, a watch list). But
// nothing yet ACTS on that grade — brief generation is byte-identical whether the
// book loves the brief or ignores it. This module is the first rung that makes
// generation RESPOND to reception.
//
// THE KNOB. Both pulse summarizers surface the same shape: ONE headline focus +
// a supporting cast (pulseBriefing.summarizePortfolioPulse does `led.slice(1, 4)`
// — a hardcoded cap of 3 "also" rows). That supporting-cast breadth is the one
// real, bounded, reversible knob in brief assembly that nothing tunes. This module
// turns the portfolio engagement grade into that breadth:
//
//   well_received (rate ≥ 0.75) → the brief has EARNED room to say a little more
//                                  → widen the supporting cast (cap 3 → 4).
//   fair          (0.50–0.74)   → neutral → cap stays 3 (byte-identical to today).
//   poorly_received (< 0.50)    → it's landing flat → tighten to the essentials
//                                  → narrow the cast (cap 3 → 2).
//   declining trend             → SHARPENS one more step, but ONLY toward tightening.
//
// THE SAFETY ASYMMETRY (the load-bearing design choice). Tightening is the SAFE
// direction: it trims secondary prose, never the headline. Widening spends the
// reader's attention, so it must be EARNED by a proven LEVEL (a well_received
// label over enough votes), never by a short-window trend. Hence: a declining
// trend can pull the cap DOWN (eager to tighten), but no trend ever pushes it UP
// (widening waits for the level). A well_received brief that is slipping
// (well_received + declining) holds at neutral rather than widening — it does not
// get to keep spending attention while reception fades.
//
// SAFETY FLOOR. The headline (`led[0]`) is NEVER touched by this knob — only the
// supporting tail flexes. Even at MIN_CAP the brief still leads with the single
// most important thing plus one supporting row, so engagement can make the brief
// tighter or richer but can NEVER suppress what matters most or bury the reader.
// Counts/posture/confidence are permutation-invariant upstream and never move.
//
// NON-CIRCULAR (mirrors pulseTuning's discipline). The engagement grade is
// measured from votes that are completely independent of this cap — the reader
// graded yesterday's brief; the cap shapes tomorrow's. Input never depends on
// output, so the controller is stable: it cannot chase its own tail.
//
// CONTRACT (identical to pulseTuning / briefLeadPolicy): a grade in → a bounded
// knob out. NO DB, NO clock, NO network, NO LLM, NO mutation. NEVER throws — a
// missing/garbled grade abstains to the neutral base (a guaranteed no-op). The
// narrator returns '' for audience:'client' UNCONDITIONALLY; the whole knob is
// agency-internal — the client only ever experiences the EFFECT (a tighter or
// richer brief), never the machinery. This is the exact precedent of the
// lead-policy tower: the client's PRESENTATION may be tuned by agency-side
// learning, but the policy object itself never crosses into the client pack.
// ============================================================

// The supporting-cast cap nothing tuned before: pulseBriefing did `led.slice(1, 4)`.
const BASE_CAP = 3 // neutral — reproduces today's brief exactly.
const MIN_CAP = 1 // safety floor: headline + at least one supporting row always survive.
const MAX_CAP = 5 // ceiling: a beloved brief can't balloon into a wall of text.

// One step per signal — a gentle nudge, never a silencer (cf. briefLeadPolicy ±20%).
const WIDEN_STEP = 1
const TIGHTEN_STEP = 1

// Reception bands — must match briefEngagement.engagementLabel exactly.
const WELL = 'well_received'
const POORLY = 'poorly_received'
// (FAIR is the neutral middle — no constant needed; it simply moves nothing.)

const DECLINING = 'declining'

function posIntOr(raw, dflt) {
  const n = Math.floor(Number(raw))
  return Number.isFinite(n) && n >= 1 ? n : dflt
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v))
}

function round(v, dp = 4) {
  const f = Math.pow(10, dp)
  return Math.round(Number(v) * f) / f
}

// ── the controller: a portfolio engagement grade → a bounded supporting-cast cap ──
// `grade` is a summarizeBriefEngagement result (or the getPortfolioEngagement
// rollup, which spreads one at top level): { status, helpful_rate, label, trend, n }.
function deriveBriefEmphasis(grade, opts = {}) {
  const base = posIntOr(opts.baseCap, BASE_CAP)
  // Rails are pure guards (like pulseTuning's MIN/MAX_FACTOR); widen them if odd
  // opts would otherwise put the floor above the base or the ceiling below it.
  const lo = Math.min(posIntOr(opts.minCap, MIN_CAP), base)
  const hi = Math.max(posIntOr(opts.maxCap, MAX_CAP), base)

  const g = grade && typeof grade === 'object' ? grade : {}
  const rate = Number(g.helpful_rate)
  // `!= null` rejects null/undefined BEFORE Number() coerces them (Number(null) === 0,
  // which would masquerade as a real rate of zero); a null rate means "no track record".
  const hasRate = g.status === 'graded' && g.helpful_rate != null && Number.isFinite(rate)

  // Honest abstention: no track record → the neutral base, a guaranteed no-op.
  if (!hasRate) {
    return {
      status: 'abstained',
      also_cap: base,
      base_cap: base,
      min_cap: lo,
      max_cap: hi,
      delta: 0,
      direction: 'neutral',
      helpful_rate: null,
      label: null,
      trend: null,
      n: posIntOr(g.n, 0),
      reason: 'no_track_record',
    }
  }

  const label = g.label || null
  const trend = g.trend || null

  // Level moves the cap in either direction; trend only ever sharpens tightening.
  let delta = 0
  if (label === WELL) delta += WIDEN_STEP
  else if (label === POORLY) delta -= TIGHTEN_STEP
  if (trend === DECLINING) delta -= TIGHTEN_STEP // safe direction only — never widens.

  const alsoCap = clamp(base + delta, lo, hi)
  const realDelta = alsoCap - base // report the post-clamp truth, not the intent.
  const direction = realDelta > 0 ? 'widen' : realDelta < 0 ? 'tighten' : 'neutral'
  const status = realDelta === 0 ? 'idle' : 'tuned'

  let reason
  if (realDelta > 0) reason = 'well_received'
  else if (realDelta < 0) reason = label === POORLY ? 'poorly_received' : 'reception_declining'
  else reason = 'steady_reception'

  return {
    status, // 'tuned' (cap moved) | 'idle' (graded, held neutral) | 'abstained'
    also_cap: alsoCap, // the knob the briefing assembly consumes.
    base_cap: base, // the neutral the knob is measured against.
    min_cap: lo,
    max_cap: hi,
    delta: realDelta, // signed; +widen / −tighten / 0 hold.
    direction,
    helpful_rate: round(rate, 4),
    label,
    trend,
    n: posIntOr(g.n, 0),
    reason,
  }
}

// ── the agency-only narrator ──────────────────────────────────────────────────────
// '' for clients UNCONDITIONALLY (the privacy line). '' when nothing changed.
function narrateBriefEmphasis(policy, opts = {}) {
  if (opts.audience === 'client') return '' // load-bearing — never leak the knob.
  if (!policy || typeof policy !== 'object') return ''
  if (policy.status !== 'tuned') return '' // abstained/idle changed nothing for the reader.

  const pct = Math.round(Number(policy.helpful_rate) * 100)
  const cap = policy.also_cap
  const base = policy.base_cap
  const item = (n) => (n === 1 ? 'item' : 'items')

  if (policy.direction === 'widen') {
    return `Reception has been strong (~${pct}% of readers found the brief useful), so it's carrying a little more of the supporting picture (${cap} ${item(cap)}, up from ${base}).`
  }
  if (policy.direction === 'tighten') {
    const slipping = policy.trend === DECLINING ? ' and slipping' : ''
    return `Reception has been mixed${slipping} (~${pct}% of readers found the brief useful), so it's leading tighter — just the essentials (${cap} ${item(cap)}, down from ${base}).`
  }
  return ''
}

module.exports = {
  deriveBriefEmphasis,
  narrateBriefEmphasis,
  BASE_CAP,
  MIN_CAP,
  MAX_CAP,
}
