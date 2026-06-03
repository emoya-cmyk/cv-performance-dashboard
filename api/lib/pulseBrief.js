'use strict'

// ============================================================
// lib/pulseBrief.js — the AI Morning Brief: a grounded daily narrative, the
// daily analog of the weekly recap (lib/evidence.js + lib/ai.js + lib/recap.js).
//
// Where the weekly recap narrates a closed week's facts, the Morning Brief
// narrates *this morning's* live pulse — "here's where things stand, here's the
// one thing to look at, here's what changed since yesterday" — in a warm,
// human, good-morning voice.
//
// This module is the PURE, deterministic half (the "9a" layer):
//
//   buildClientBriefPack(pulse)    — a numbers-only evidence pack over a
//     getClientPulse() payload, CLIENT-SAFE by construction (no peer names, no
//     z/baseline/tuning machinery). Every number a brief could legitimately
//     quote is present as a structural numeric leaf, so the grounding verifier
//     in lib/ai.js (collectAllowedNumbers/verifyGrounding) can vet any draft.
//
//   buildPortfolioBriefPack(pulse) — the same over a getPortfolioPulse()
//     payload, for the AGENCY surface (names clients, keeps counts), but still
//     strips per-signal machinery (z/severity/triage prose) and confidence
//     shares so the brief's number set is fully owned by CODE.
//
//   templateClientBrief(pack) / templatePortfolioBrief(pack) — grounded-by-
//     construction deterministic fallbacks. They reuse the engine's OWN narrated
//     fragments verbatim (the client/agency headline, the streak note, the
//     resolved note, the continuity line) — never re-deriving "important" — and
//     stitch them into a morning frame. Because every number in those fragments
//     is also a structural leaf in the pack, the output is verifiable.
//
// The LLM half (generateBriefText, a narrate-only Anthropic call reusing the
// same verifier, with these templates as the fallback) lands in the "9b" layer.
// This file makes ZERO network/DB calls and is total: bad/empty input degrades
// to a calm "all steady this morning" pack, never a throw.
// ============================================================

// ── tiny pure helpers ────────────────────────────────────────────────────────
// r1 mirrors lib/ai.js / lib/evidence.js rounding so the verifier math lines up.
const r1 = n => Math.round((Number(n) || 0) * 10) / 10
const nonNegInt = v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0 }
const intOrNull = v => (Number.isInteger(v) ? v : null)
const str = v => (typeof v === 'string' && v ? v : null)
const lc = s => (typeof s === 'string' ? s.toLowerCase() : '')
const capFirst = s => { const t = typeof s === 'string' ? s : ''; return t ? t.charAt(0).toUpperCase() + t.slice(1) : t }
const plural = (n, one, many) => (Math.abs(Number(n)) === 1 ? one : many)
const periodOf = asOf => (asOf ? { label: asOf, week_start: asOf, week_end: asOf } : null)

// ============================================================
// CLIENT brief pack — from a getClientPulse() payload. Client-safe.
// ============================================================
function buildClientBriefPack(pulse) {
  const briefing = (pulse && pulse.briefing) || null
  const cont     = (pulse && pulse.continuity) || null
  const asOf     = str(pulse && pulse.as_of)

  // A focus exists only when the engine actually raised one this morning.
  const hasFocus = !!(briefing && briefing.status === 'briefing' && briefing.focus)
  const bf = hasFocus ? briefing.focus : null
  const focus = bf ? {
    metric:    str(bf.metric),
    label:     str(bf.label),
    direction: str(bf.direction),
    delta_pct: r1(bf.delta_pct),
    lane:      str(bf.lane),
  } : null

  const cf = (cont && cont.focus) || null
  const resolvedItems = Array.isArray(cont && cont.resolved) ? cont.resolved : []

  // Continuity memory — all client-egress-safe (machinery-free by design of
  // summarizeContinuity). since_back is carried so any streak/easing note the
  // engine wrote (which may quote it) stays grounded.
  const memory = {
    new_count:        nonNegInt(cont && cont.new_count),
    persisting_count: nonNegInt(cont && cont.persisting_count),
    escalating_count: nonNegInt(cont && cont.escalating_count),
    resolved_count:   resolvedItems.length,
    focus_status:     cf ? str(cf.status) : null,
    streak:           cf ? intOrNull(cf.streak) : null,
    since_back:       cf ? intOrNull(cf.since_back) : null,
    streak_capped:    !!(cf && cf.streak_capped),
    trend:            cf ? str(cf.trend) : null,
  }

  const resolved = resolvedItems.map(r => ({ metric: str(r && r.metric), label: str(r && r.label) }))

  // The engine's OWN client-toned sentences. Each is already grounded in the
  // numbers we carry structurally, so reusing them verbatim stays verifiable —
  // and honors "the surface never re-derives the engine's phrasing". The focus
  // streak note lives on the matching signal (same lookup ClientView uses).
  const sigs = Array.isArray(pulse && pulse.signals) ? pulse.signals : []
  const focusSig = focus ? sigs.find(s => s && s.metric === focus.metric) : null
  const engine_notes = {
    headline:     str(briefing && briefing.headline_text),
    focus_streak: str(focusSig && focusSig.continuity_client_note),
    resolved:     str(cont && cont.resolved_client_note),
  }

  return {
    audience: 'client',
    as_of: asOf,
    period: periodOf(asOf),
    posture: str(briefing && briefing.posture),
    status:  str(briefing && briefing.status),
    meta: {
      quiet:        !focus,
      has_focus:    !!focus,
      has_resolved: resolved.length > 0,
    },
    focus,
    also_count: nonNegInt(briefing && briefing.also_count),
    memory,
    resolved,
    engine_notes,
  }
}

// ============================================================
// PORTFOLIO brief pack — from a getPortfolioPulse() payload. Agency surface.
// ============================================================
function buildPortfolioBriefPack(pulse) {
  const briefing = (pulse && pulse.briefing) || null
  const cont     = (pulse && pulse.continuity) || null
  const asOf     = str(pulse && pulse.as_of)

  const isBriefing = !!(briefing && briefing.status === 'briefing')
  const bc = (briefing && briefing.counts) || {}
  const counts = {
    adverse:   nonNegInt(bc.adverse),
    clients:   nonNegInt(bc.clients),
    act_now:   nonNegInt(bc.act_now),
    tailwinds: nonNegInt(bc.tailwinds),
    proven:    nonNegInt(bc.proven),
    learning:  nonNegInt(bc.learning),
  }

  // Top driver — structured fields ONLY. The engine's firing headline_text
  // embeds per-signal machinery (z, baseline, triage prose) we don't carry, so
  // we rebuild the lead clause from these grounded fields instead of echoing it.
  const top = (isBriefing && briefing.headline) || null
  const headline = top ? {
    client_name: str(top.client_name),
    metric:      str(top.metric),
    label:       str(top.label),
    lane:        str(top.lane),
    direction:   str(top.direction),
    delta_pct:   r1(top.delta_pct),
  } : null

  const alsoRows = Array.isArray(briefing && briefing.also) ? briefing.also : []
  const also = alsoRows.map(r => ({
    client_name: str(r && r.client_name),
    label:       str(r && r.label),
    lane:        str(r && r.lane),
  }))

  const memory = {
    new_count:          nonNegInt(cont && cont.new_count),
    persisting_count:   nonNegInt(cont && cont.persisting_count),
    escalating_count:   nonNegInt(cont && cont.escalating_count),
    resolved_count:     nonNegInt(cont && cont.resolved_count),
    clients_new:        nonNegInt(cont && cont.clients_new),
    clients_escalating: nonNegInt(cont && cont.clients_escalating),
    clients_resolved:   nonNegInt(cont && cont.clients_resolved),
  }

  // Confidence stays qualitative — label + note only, never the raw shares (a
  // 0.57 share the model might render as "57%" has no home in the number set).
  const conf = (briefing && briefing.confidence) || null
  const confidence = {
    label: conf ? str(conf.label) : null,
    note:  conf ? str(conf.note)  : null,
  }

  const engine_notes = {
    // Only the QUIET headline is number-safe (its lone number is the tailwinds
    // count, already in counts). The firing headline carries machinery → omit.
    headline:   !isBriefing ? str(briefing && briefing.headline_text) : null,
    also:       str(briefing && briefing.also_text),
    continuity: str(cont && cont.note),
    confidence: confidence.note,
  }

  return {
    audience: 'agency',
    as_of: asOf,
    period: periodOf(asOf),
    posture: str(briefing && briefing.posture),
    status:  str(briefing && briefing.status),
    meta: {
      quiet:        !isBriefing,
      has_action:   counts.adverse > 0,
      has_resolved: memory.resolved_count > 0,
    },
    counts,
    headline,
    also,
    memory,
    confidence,
    engine_notes,
  }
}

// ============================================================
// Deterministic fallbacks — grounded by construction.
// ============================================================
function templateClientBrief(pack) {
  const p = pack || {}
  const notes = p.engine_notes || {}
  const focus = p.focus || null
  const parts = ['Good morning.']

  if (focus) {
    if (notes.headline) parts.push(notes.headline)
    const d = focus.delta_pct
    if (typeof d === 'number' && Number.isFinite(d) && d !== 0) {
      const dir = focus.direction === 'down' ? 'below' : 'above'
      parts.push(`${capFirst(focus.label || 'It')} is running about ${Math.abs(d)}% ${dir} your usual pace.`)
    }
    if (notes.focus_streak) parts.push(notes.focus_streak)
  } else {
    parts.push(notes.headline || 'All steady this morning — nothing needs your attention right now.')
  }
  // An overnight win rides even on a quiet morning.
  if (notes.resolved) parts.push(notes.resolved)
  return parts.join(' ')
}

function templatePortfolioBrief(pack) {
  const p = pack || {}
  const c = p.counts || {}
  const notes = p.engine_notes || {}
  const h = p.headline || null
  const parts = ['Good morning.']

  if (h) {
    parts.push(leadCountSentence(c))
    let s = `First up, ${h.client_name || 'one client'} — ${lc(h.label || 'a metric')}`
    const d = h.delta_pct
    if (typeof d === 'number' && Number.isFinite(d) && d !== 0) {
      const dir = h.direction === 'down' ? 'below' : 'above'
      s += `, running about ${Math.abs(d)}% ${dir} pace`
    }
    parts.push(s + '.')
    if (notes.also) parts.push(notes.also)
  } else {
    parts.push(notes.headline || 'Quiet across the book — every metric is sitting inside its usual band this morning.')
  }
  if (notes.continuity) parts.push(notes.continuity + '.')
  const tw = nonNegInt(c.tailwinds)
  if (h && tw > 0) parts.push(`On the bright side, ${tw} ${plural(tw, 'metric is', 'metrics are')} pacing ahead across the book.`)
  if (notes.confidence && p.confidence && p.confidence.label && p.confidence.label !== 'n/a') parts.push(notes.confidence)
  return parts.join(' ')
}

function leadCountSentence(c) {
  const a = nonNegInt(c.adverse), cl = nonNegInt(c.clients), an = nonNegInt(c.act_now)
  let lead = a === 1
    ? 'One alert to act on this morning'
    : `${a} alerts across ${cl} ${plural(cl, 'client', 'clients')} to act on this morning`
  if (an > 0) lead += `, ${an} of them act-now`
  return lead + '.'
}

module.exports = {
  buildClientBriefPack,
  buildPortfolioBriefPack,
  templateClientBrief,
  templatePortfolioBrief,
}
