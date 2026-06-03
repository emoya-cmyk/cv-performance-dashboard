'use strict'

// ============================================================
// lib/briefQuality.js — does the Morning Brief still speak in its own words?
//
// THE GAP THIS CLOSES
// -------------------
// The Daily Pulse chain grew a NARRATION layer in (9): [[pulseBrief]] packs a
// morning's pulse into a numbers-only evidence pack, generateBriefText asks the model
// to narrate it, a grounding verifier rejects any draft that cites a number the pack
// doesn't carry, and a deterministic template stands in whenever the model is
// unreachable or its draft fails grounding. That last clause hides a quiet failure
// mode: the brief NEVER breaks. A missing API key, a dead network, a model that
// two-times an ungrounded draft — every one of these degrades SILENTLY to the
// template, which is grounded-by-construction and reads almost as well. So the system
// can slide from "an AI analyst writes your brief each morning" to "a fill-in-the-
// blanks form writes it" and nothing, anywhere, says so. Every other layer in this
// family grades ITSELF — [[pulseReliability]] grades persistence, [[pulseAccuracy]]
// grades the forecast, [[pulseTuning]] grades the trigger — but the newest, most
// visible layer, the one we hang an "AI Analyst" badge on, had no self-grade at all.
// This module is that missing audit: it reads the brief HISTORY the engine already
// persists (the ai_briefs table) and reports how often narration actually SURVIVED
// versus fell back to the template — per audience, with an early-warning streak for
// when it has been falling back lately.
//
// THE ONE TELEMETRY FACT THAT MAKES THIS HONEST
// ---------------------------------------------
// `grounded` is the WRONG signal and it would lie if we used it. Every persisted brief
// row carries grounded:true — NOT because narration always succeeds, but because the
// template fallback is grounded BY CONSTRUCTION, so even the failure paths return
// grounded:true. The real, only discriminator is `model`: generateBriefText stamps
// model:'template' on exactly the rows where the deterministic fallback was used (no
// key, transport error, or two ungrounded drafts) and a real model id on the rows the
// LLM actually wrote AND that passed grounding. So narration health is read off
// `model`, never off `grounded`. We surface grounded separately, as the TRUST invariant
// it genuinely is: across the whole history it is ~always 1, and "every number you have
// ever been shown was verified" is a feature worth stating out loud — just not a measure
// of whether the AI is still doing the writing.
//
// NOT EVERY TEMPLATE IS A FAILURE — THE NARRATABLE GATE
// -----------------------------------------------------
// A dead-quiet morning (nothing raised, nothing resolved) is SUPPOSED to use the
// template — generateBriefText never even calls the model then, on purpose, to skip a
// network round-trip on "all steady." Counting those as narration failures would
// slander a healthy system every calm week. So this module reproduces the EXACT gate
// the generator uses — briefWorthNarrating, mirrored here as isNarratable over the same
// pack.meta fields (client: has_focus|has_resolved|focus; agency: has_action|
// has_resolved|headline) — and grades coverage ONLY over briefs that were worth
// narrating. quiet ≠ fellback. The mirror is load-bearing: if it drifts from the
// generator's gate the coverage denominator is wrong, so the tests pin BOTH branches.
//
// PURE: rows in, a health summary out. No DB, no clock-of-now, no network, no LLM, no
// mutation, never throws. Reasons only over fields already on each persisted row, so it
// stays trivially testable on plain literals — exactly like the rest of the pulse family.
// The agency-only narrate helper returns '' for a client audience by construction, so the
// no-leak discipline (narration machinery is internal) is enforced in the module itself,
// not left to each surface to remember.
// ============================================================

// Coverage at or above this share reads as "the AI is writing the briefs"; below it,
// narration is mixed with template fallback. A pure DISPLAY threshold — every number it
// labels is still reported raw, so a caller can band differently via opts if it wants.
const RICH_COVERAGE = 0.8

const str = (x) => (x == null ? '' : String(x))
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const round = (x, dp) => {
  const f = 10 ** dp
  return Math.round(x * f) / f
}
const plural = (n, one, many) => (Math.abs(Number(n)) === 1 ? one : many)

// A row's brief_text came from the template iff model is the sentinel (or absent).
// Absent is treated as template DEFENSIVELY — an unstamped row never counts as a live
// narration. This is the SOLE narrated-vs-fellback discriminator (see header).
const isTemplate = (model) => !model || model === 'template'

// Accept either a parsed pack object or the raw JSON string a straight-from-DB row may
// carry, so the module works on normalized rows AND raw rows. Returns null on anything
// unparseable — a row whose pack we can't read can't be PROVEN narratable, so it falls to
// the 'quiet' (non-narratable) side and never inflates the failure count.
function asPack(pack) {
  if (pack && typeof pack === 'object') return pack
  if (typeof pack === 'string' && pack.length) {
    try { return JSON.parse(pack) } catch { return null }
  }
  return null
}

// MIRROR of generateBriefText's briefWorthNarrating (lib/ai.js): the morning carried
// something the model would have been asked to narrate. Same fields, same OR-shape, split
// by audience. Drift here silently miscounts coverage, so this is pinned in both branches.
function isNarratable(pack) {
  const p = asPack(pack)
  if (!p) return false
  const m = p.meta || {}
  if (p.audience === 'agency') return !!(m.has_action || m.has_resolved || p.headline)
  return !!(m.has_focus || m.has_resolved || p.focus)
}

// One persisted brief row → its narration state:
//   'quiet'    — the template was used by DESIGN (nothing worth narrating); not a failure.
//   'narrated' — the LLM wrote it and it passed grounding (model is a real id).
//   'fellback' — it WAS worth narrating but degraded to the template — the only unhealthy
//                state, the one this whole module exists to count.
function briefRowState(row) {
  if (!row || !isNarratable(row.pack)) return 'quiet'
  return isTemplate(row.model) ? 'fellback' : 'narrated'
}

function healthLabel(b, richCoverage) {
  if (b.total === 0) return 'no-data'
  if (b.narratable === 0) return 'quiet'         // nothing to narrate in the window
  if (b.narrated === 0) return 'template-only'   // every narratable brief fell back
  return b.coverage >= richCoverage ? 'rich' : 'mixed'
}

// Build a narration-health bucket from rows ALREADY sorted ascending by as_of. Sorted
// input lets latest/streak read straight off the order — no second sort per bucket.
function buildBucket(sortedRows, richCoverage) {
  let narratable = 0
  let narrated = 0
  let fellback = 0
  const models = {}
  const seq = []            // states of narratable rows, in as_of order
  let latestRow = null
  let latestState = null

  for (const row of sortedRows) {
    const state = briefRowState(row)
    if (state === 'quiet') continue
    narratable++
    seq.push(state)
    latestRow = row
    latestState = state
    const key = isTemplate(row.model) ? 'template' : str(row.model)
    models[key] = (models[key] || 0) + 1
    if (state === 'narrated') narrated++
    else fellback++
  }

  // How many of the MOST-RECENT narratable briefs fell back in a row — the early warning
  // that narration has been degrading lately (skips quiet rows; they don't break a run).
  let streakFellback = 0
  for (let i = seq.length - 1; i >= 0 && seq[i] === 'fellback'; i--) streakFellback++

  const bucket = {
    total: sortedRows.length,
    narratable,
    quiet: sortedRows.length - narratable,
    narrated,
    fellback,
    coverage: narratable > 0 ? round(narrated / narratable, 4) : null,
    models,
    latest: latestRow ? { as_of: str(latestRow.as_of), state: latestState } : null,
    streak_fellback: streakFellback,
  }
  bucket.health = healthLabel(bucket, richCoverage)
  return bucket
}

const ymdToUTC = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(str(s))
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null
}
// Inclusive day span between two YYYY-MM-DD strings (from..to both counted). Date.UTC is
// a pure static call — deterministic, no clock-of-now — so this stays testable.
function daySpan(from, to) {
  const a = ymdToUTC(from)
  const b = ymdToUTC(to)
  if (a == null || b == null) return null
  return Math.round((b - a) / 86400000) + 1
}
function windowOf(sorted) {
  if (!sorted.length) return { from: null, to: null, days: 0 }
  const from = str(sorted[0].as_of)
  const to = str(sorted[sorted.length - 1].as_of)
  return { from, to, days: daySpan(from, to) }
}

/**
 * summarizeBriefQuality(rows, opts)
 *   rows : persisted ai_briefs rows (normalized or raw). Each needs at least
 *          { as_of, audience, model, grounded, pack } — scope_key is used only as a
 *          stable sort tie-break. `model === 'template'` (or absent) marks the
 *          deterministic fallback; any other value is a live LLM narration.
 *   opts : { richCoverage=0.8 } — the coverage share at/above which a bucket reads as
 *          'rich' (AI-written). Optional; validated into (0,1].
 *
 * Returns (never throws):
 *   {
 *     total,                       // rows considered
 *     window: { from, to, days },  // min..max as_of (YYYY-MM-DD) + inclusive day span
 *     grounded_rate,               // grounded-true / total, the TRUST invariant (~1); null if empty
 *     all_grounded,                // grounded_rate === 1 (vacuously true when empty)
 *     overall:    <bucket>,        // across all audiences
 *     by_audience: { client: <bucket>, agency: <bucket> },
 *   }
 *
 *   <bucket> = {
 *     total, narratable, quiet, narrated, fellback,
 *     coverage,            // narrated / narratable (rounded 4) | null when none narratable
 *     models,              // { '<model-id>'|'template': count } over the NARRATABLE rows
 *     latest,              // { as_of, state:'narrated'|'fellback' } | null (most recent narratable)
 *     streak_fellback,     // consecutive most-recent narratable briefs that fell back (≥0)
 *     health,              // 'no-data' | 'quiet' | 'template-only' | 'mixed' | 'rich'
 *   }
 *
 * grounded health and narration health are ORTHOGONAL by design: grounded_rate is the
 * verified-numbers guarantee (read off `grounded`), coverage is the AI-is-writing measure
 * (read off `model`). Conflating them is the exact mistake this module refuses to make.
 */
function summarizeBriefQuality(rows, opts = {}) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : []
  const richCoverage =
    Number.isFinite(opts.richCoverage) && opts.richCoverage > 0 && opts.richCoverage <= 1
      ? opts.richCoverage
      : RICH_COVERAGE

  // Stable ascending sort by as_of (tie-break scope_key, then audience) so every bucket's
  // latest/streak reads off one order and the result is identical for any input ordering.
  const sorted = list.slice().sort((a, b) =>
    cmpStr(str(a.as_of), str(b.as_of)) ||
    cmpStr(str(a.scope_key), str(b.scope_key)) ||
    cmpStr(str(a.audience), str(b.audience)))

  const clientRows = sorted.filter((r) => str(r.audience) === 'client')
  const agencyRows = sorted.filter((r) => str(r.audience) === 'agency')

  // Trust invariant: across ALL rows, the share carrying grounded:true. ~Always 1 by
  // construction (the template fallback is grounded too); surfaced as the verified-numbers
  // guarantee, NOT as a narration-health measure (see header).
  const total = sorted.length
  const groundedCount = sorted.reduce((n, r) => n + (r.grounded ? 1 : 0), 0)

  return {
    total,
    window: windowOf(sorted),
    grounded_rate: total > 0 ? round(groundedCount / total, 4) : null,
    all_grounded: total > 0 ? groundedCount === total : true,
    overall: buildBucket(sorted, richCoverage),
    by_audience: {
      client: buildBucket(clientRows, richCoverage),
      agency: buildBucket(agencyRows, richCoverage),
    },
  }
}

/**
 * narrateBriefHealth(bucket, opts) — ONE grounded agency sentence about a bucket's
 * narration health. AGENCY-ONLY by construction: returns '' for opts.audience === 'client'
 * (narration machinery is internal calibration; the client sees only the brief itself,
 * never how often the model wrote it). Returns '' for an empty or all-quiet bucket — there
 * is no health claim worth making when nothing needed narrating. Every number it cites
 * (narrated, narratable, streak_fellback) is straight off the bucket, so the sentence can
 * never disagree with the figures it explains.
 *   opts : { audience, scopeLabel='The AI' }
 */
function narrateBriefHealth(bucket, opts = {}) {
  if (opts.audience === 'client') return ''
  if (!bucket || bucket.total === 0 || bucket.narratable === 0) return ''
  const grounded = ' — all grounded to your verified numbers.'

  if (bucket.health === 'template-only') {
    return `Every morning brief used the safe template (the narration model wasn't reached)${grounded}`
  }

  const scope = opts.scopeLabel || 'The AI'
  const n = bucket.narrated
  const d = bucket.narratable
  const noun = plural(d, 'brief', 'briefs')
  let s =
    bucket.health === 'rich'
      ? `${scope} wrote ${n} of ${d} morning ${noun} in its own words${grounded}`
      : `${scope} wrote ${n} of ${d} morning ${noun} in its own words; the rest used the safe template${grounded}`

  if (bucket.streak_fellback >= 2) {
    s += ` Heads up — the last ${bucket.streak_fellback} fell back to the template.`
  }
  return s
}

module.exports = {
  summarizeBriefQuality,
  narrateBriefHealth,
  isNarratable,
  briefRowState,
  RICH_COVERAGE,
}
