'use strict'

// ============================================================
// lib/adviceAnswer.js — the grounded "what should I do?" answer for the Ask box.
//
// The Ask box can already answer the PAST ("what WAS revenue last week"), the WHO
// (contribution.js), the WHY (ratioAttribution.js), the FUTURE (forecastAnswer.js)
// and the GOAL ("are we on track", pacingAnswer.js). The one question that ties them
// all together — the one an owner actually opens the dashboard to ask — is "so what
// should I DO about it?" Every piece needed to answer that already exists: the engine
// raises ranked findings, derives a grounded recommended_action for each on read
// (insights.recommendedAction), annotates the advice with its learned track record
// (attachEfficacyNotes) and — once a play proves ineffective — REVISES the advice and
// bumps its urgency (attachEscalations → escalation.js). This module is the missing
// adapter that turns that already-decorated, already-ranked feed into a focused,
// plain-language to-do list for the chat surface.
//
// It is the consumer-facing twin of the agency Intelligence feed: same findings, same
// grounded actions, same self-improving escalation — just reshaped into "here is what
// to focus on, sharpest first." Because the feed is already ranked (feedSort: severity
// → status → learned-weight × score) this module never re-prioritizes; it preserves
// that order, selects the items that carry an actionable recommendation, and caps to a
// focused top-N (reporting the true total so a cap is never silent).
//
// ACCURATE BY CONSTRUCTION — no LLM arithmetic anywhere. Every word of advice is copied
// verbatim from the finding's own recommended_action (or, for an escalated play on the
// client surface, its softened escalation.client_text); every figure inside that text
// was already grounded upstream by recommendedAction/escalation. This module only
// SELECTS and RESHAPES — it computes no numbers of its own beyond counting the list.
//
// AUDIENCE-AWARE & LEAK-SAFE. The whole feed is one client's own findings (getInsightFeed
// is per-client), so an advice answer names no other tenant and is equally safe on the
// agency Intelligence page and a client's /my-dashboard — exactly like the per-client
// recommendation cards both surfaces already render. The only audience difference is the
// wording of an ESCALATED action: agency reads the raw revised text (which carries the
// "the usual fix hasn't moved the needle" clause and the ops framing), the client reads
// the softened escalation.client_text (same change of approach, no failure stat, no ops
// language) — byte-identical to how intel-v5 (2d) already splits those two surfaces. A
// non-escalated recommended_action is already client-safe (it is the very text intel-v3
// (2) put on /my-dashboard), so both audiences read it unchanged. The efficacy note is a
// play's OWN pooled rate — it names no peer — so it rides both surfaces verbatim too.
//
// PURE: findings in, verdict + sentence out. No DB, no clock, no network, no LLM, no
// mutation of inputs (matching pacingAnswer.js / forecastAnswer.js). The caller (ask.js)
// resolves the client, pulls the feed, runs the SAME decoration pipeline the route uses
// (attachEscalations(attachEfficacyNotes(feed, table), table)) and passes the result
// here, so this module never reaches back into the engine. Never throws: a non-array or
// a feed with nothing actionable degrades to a quiet, honest verdict, never an exception.
// ============================================================

// How many actions a single "what should I do?" answer surfaces by default — a focused
// to-do list, not the whole feed. The true total is always reported on the verdict so a
// cap is visible, never silent (matching the "no silent caps" honesty rule).
const DEFAULT_LIMIT = 5
const MAX_LIMIT = 50

function clampLimit(n) {
  const v = Math.floor(Number(n))
  if (!Number.isFinite(v) || v < 1) return DEFAULT_LIMIT
  return Math.min(v, MAX_LIMIT)
}

// Pick the right wording for one finding's action, by audience. Returns null when the
// finding carries no usable advice (defensive — every normalized feed row has a
// recommended_action, but a malformed input must drop out rather than surface blank).
//   • agency           → the recommended_action text verbatim (already carries the
//                         escalation clause + ops framing when the play escalated);
//   • client + escalated → the SOFTENED escalation.client_text (a change of approach,
//                         no failure stat, no "escalate"/ops language);
//   • client + normal  → the recommended_action text (already client-safe since v3).
function actionTextFor(finding, audience) {
  const ra = finding && finding.recommended_action
  if (!ra || !ra.text) return null
  if (audience === 'client' && finding.escalation && finding.escalation.client_text) {
    return finding.escalation.client_text
  }
  return ra.text
}

/**
 * adviceAnswer(findings, opts)
 *   findings : an ALREADY-DECORATED, ALREADY-RANKED client feed — the output of
 *              attachEscalations(attachEfficacyNotes(getInsightFeed(clientId), table), table).
 *              Each item: { id, kind, metric, severity, status, title,
 *                           recommended_action:{ text, urgency[, escalated, escalation] },
 *                           efficacy_note?:{...}, escalation?:{..., client_text } }.
 *   opts     : { audience:'agency'|'client', limit } — audience picks escalated wording;
 *              limit caps the surfaced list (default 5, max 50).
 *
 * Returns a verdict (never null, never throws):
 *   { status:'actionable'|'all_clear'|'none', audience, count, total,
 *     actions:[{ id, kind, metric, severity, urgency, title, action, escalated, efficacy_note }] }
 *   • 'none'      — input was not an array (garbage in → quiet no-op, like pacing's none);
 *   • 'all_clear' — a real array with nothing actionable (an honest "you're caught up");
 *   • 'actionable'— one or more recommendations, sharpest first, capped to `limit`.
 *   count = actions surfaced; total = actionable findings available (so a cap is visible).
 */
function adviceAnswer(findings, opts = {}) {
  const audience = opts.audience === 'client' ? 'client' : 'agency'
  const limit = clampLimit(opts.limit)

  if (!Array.isArray(findings)) {
    return { status: 'none', audience, count: 0, total: 0, actions: [] }
  }

  // Preserve the feed's existing ranking — never re-prioritize. Keep only items that
  // carry usable advice, then cap to a focused top-N. Non-mutating throughout
  // (filter/map/slice build new arrays/objects; inputs are read, never written).
  const actionable = findings.filter((f) => actionTextFor(f, audience) != null)
  const total = actionable.length

  if (total === 0) {
    return { status: 'all_clear', audience, count: 0, total: 0, actions: [] }
  }

  const actions = actionable.slice(0, limit).map((f) => {
    const ra = f.recommended_action
    return {
      id:            f.id,
      kind:          f.kind,
      metric:        f.metric,
      severity:      f.severity,
      urgency:       ra.urgency,
      title:         f.title || '',
      action:        actionTextFor(f, audience),  // audience-correct, copied verbatim
      escalated:     !!f.escalation,              // top-level escalation ⟺ a revised play
      efficacy_note: f.efficacy_note || null,     // the play's own pooled rate (client-safe), verbatim
    }
  })

  return { status: 'actionable', audience, count: actions.length, total, actions }
}

// One grounded lead sentence for the answer — deterministic, no LLM. The numbers it
// states (how many actions, how many are act-now) are counted straight off the verdict
// it is handed, so it can never disagree with the cards rendered beside it. Tone shifts
// by audience only on the all-clear line; the actionable summary is identical for both.
//   actionable : "3 recommended actions to focus on — 1 needs immediate attention."
//                "2 recommended actions to focus on."           (when none are act-now)
//   all_clear  : "You're all caught up — no open issues need your attention right now."  (client)
//                "All clear — no open issues need attention for this client right now."  (agency)
//   none       : ""  (nothing to say — like narratePacing on a null verdict)
function narrateAdvice(verdict, opts = {}) {
  if (!verdict) return ''
  const audience = opts.audience || verdict.audience || 'agency'

  switch (verdict.status) {
    case 'all_clear':
      return audience === 'client'
        ? "You're all caught up — no open issues need your attention right now."
        : 'All clear — no open issues need attention for this client right now.'
    case 'actionable': {
      const n = verdict.count
      const now = Array.isArray(verdict.actions)
        ? verdict.actions.filter((a) => a && a.urgency === 'act_now').length
        : 0
      let s = `${n} recommended action${n === 1 ? '' : 's'} to focus on`
      if (now > 0) {
        s += ` — ${now} need${now === 1 ? 's' : ''} immediate attention.`
      } else {
        s += '.'
      }
      return s
    }
    case 'none':
    default:
      return ''
  }
}

module.exports = { adviceAnswer, narrateAdvice, DEFAULT_LIMIT, MAX_LIMIT }
