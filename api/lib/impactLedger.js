'use strict'

// ============================================================
// lib/impactLedger.js — the influence layer's accountant (PURE).
//
// The rest of the intelligence stack DOES the work: coverage.js and
// connectionHealth.js keep the data flowing, outcomes.js confirms a flagged
// problem actually got fixed, pacing.js catches a goal heading for a miss while
// there's still time, pulseAccuracy.js / efficacy.js / reallocationEfficacy.js
// keep score on whether the calls and the recommended plays actually proved out.
// What's been missing is the line that ties it together for a human: "here is the
// value this system has demonstrably delivered." That's this module. It does NOT
// detect anything new — it ledgers what the other modules already proved, into one
// attributable, honestly-weighted tally an agency can stand behind and a client
// can be reassured by.
//
// HONESTY BY CONSTRUCTION — the whole point. A bragging number nobody believes is
// worse than no number. So every win carries the confidence the upstream track
// record actually earned, and the headline figure is the RISK-ADJUSTED one:
//
//     weighted_value = value × confidence
//
// 8 early-warnings that proved out 90% of the time count as ~7.2 trustworthy wins,
// not 8. A $4,500 goal pulled back on track at 0.8 pacing-confidence protects
// ~$3,600 of defensible value, not $4,500. The gross value is kept too, but the
// number we lead with is the one that survives scrutiny. Nothing is invented:
// a win with no positive magnitude is not ledgered, and a win with no proven
// confidence simply carries the neutral default — never an inflated one.
//
// UNITS DON'T MIX. Recovered issues, vindicated budget shifts and early-warning
// hits are COUNTS; a rescued revenue goal is DOLLARS; a rescued lead/job goal is
// leads/jobs. Summing a dollar and a count into one "score" is the kind of lie
// this module exists to avoid, so totals are kept strictly per-unit. The headline
// is whichever single unit carries the most weighted value (dollars win ties — a
// protected dollar is the most legible proof there is).
//
// CANONICAL EVENT IN, LEDGER OUT. The module does not know about outcomes.js or
// pulseAccuracy.js by name — that coupling lives in the engine adapter (B2), which
// maps each upstream verdict into the one canonical impact event shape below and
// hands a flat list here. That keeps this layer a pure, testable algebra and lets
// new impact sources be added without touching it:
//
//   {
//     category:    'recovery'|'reallocation'|'pacing_save'|'early_warning',
//     client_id, client_name,          // attribution (either may be absent)
//     metric:      'revenue'|'leads'|'jobs'|null,
//     unit:        'dollars'|'leads'|'jobs'|'count',   // how to read `value`
//     value:       number > 0,         // magnitude in that unit (the gross win)
//     confidence:  number in [0,1],    // the upstream track record for this win
//     occurred_at: ISO string | null,  // for windowing/recency (never read as a clock)
//     detail:      string | null,      // a short agency-only label
//   }
//
// PURE: events in, ledger out. No DB, no clock, no network, no LLM, no input
// mutation. Deterministic: identical input → byte-identical ledger (no Date.now /
// Math.random; every order is fully tie-broken). Defensive: empty / malformed
// input → a quiet empty ledger, never a throw — "no proven wins yet" is a true and
// safe answer, and a garbage row is skipped, not fatal.
//
// AUDIENCE. Everything here is agency-grade detail (per-client roster, per-category
// breakdown, confidences). narrateImpactLedger(…, {audience:'client'}) already
// refuses to say anything client-facing that isn't both PROVEN and aggregate, but
// the deliberately-vague, leak-proof client "your wins" note — the single safe
// egress, mirroring clientConnectionNote — is assembled separately (B4). This
// module never emits a client string that names a client, a number, or a category.
// ============================================================

const CATEGORY = {
  RECOVERY:      'recovery',       // a flagged problem that outcomes.js confirmed got fixed
  REALLOCATION:  'reallocation',   // a budget shift that reallocationEfficacy.js says held up
  PACING_SAVE:   'pacing_save',    // a goal pacing.js caught early that then returned to track
  EARLY_WARNING: 'early_warning',  // a pulse call pulseAccuracy.js graded as a true positive
}
const CATEGORIES = new Set(Object.values(CATEGORY))

const UNIT = {
  DOLLARS: 'dollars',
  LEADS:   'leads',
  JOBS:    'jobs',
  COUNT:   'count',
}
const UNITS = new Set(Object.values(UNIT))

// Headline preference when weighted totals tie: a protected dollar is the most
// legible proof, then pipeline (leads), then booked work (jobs), then bare counts.
const UNIT_PRIORITY = [UNIT.DOLLARS, UNIT.LEADS, UNIT.JOBS, UNIT.COUNT]

const CATEGORY_META = {
  [CATEGORY.RECOVERY]:      { label: 'Recovered',      blurb: 'issues the system flagged that then got fixed' },
  [CATEGORY.REALLOCATION]:  { label: 'Budget shifts',  blurb: 'budget moves that proved out in backtest' },
  [CATEGORY.PACING_SAVE]:   { label: 'Pacing saves',   blurb: 'goals pulled back on track after an early miss-warning' },
  [CATEGORY.EARLY_WARNING]: { label: 'Early warnings', blurb: 'shifts called early that proved out' },
}

const DEFAULTS = {
  defaultConfidence:   0.5,   // when an event omits confidence — neutral, never an invented high
  minConfidence:       0,     // floor; entries below it are dropped (0 ⇒ keep all, weighting does the honesty)
  provenMinEvents:     3,     // a ledger only calls itself "proven" with enough distinct wins …
  provenMinConfidence: 0.6,   // … at enough effective confidence (mirrors the pulse/efficacy "proven" gates)
}

// ── tiny, boring, pure helpers ────────────────────────────────────────────────
function num(v, d = 0) {
  const n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) ? n : d
}
function clamp(n, lo, hi) { return n < lo ? lo : n > hi ? hi : n }
function clamp01(n) { return clamp(num(n, 0), 0, 1) }
function round0(n) { return Math.round(num(n, 0)) }
function round2(n) { return Math.round(num(n, 0) * 100) / 100 }
function str(v) { return typeof v === 'string' && v.trim() ? v.trim() : null }

// gross magnitudes are integers when they're counts (you can't resolve 7.5 issues),
// money/pipeline keep two places. Weighted values are EXPECTATIONS and stay
// fractional even for counts (~7.2 trustworthy wins is the honest number).
function roundValue(v, unit) { return unit === UNIT.COUNT ? round0(v) : round2(v) }

// thousands grouping for the agency sentence — deterministic, locale-free.
function fmt(n) { return String(round0(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') }

function normalizeWindow(w) {
  if (!w || typeof w !== 'object') return null
  const since = str(w.since), until = str(w.until)
  return since || until ? { since: since || null, until: until || null } : null
}

// ── normalize ONE raw impact candidate into a ledger entry (or drop it) ───────
// Numbers in, one honest entry out — or null when it isn't a real, positive,
// known-shaped win. Never throws on garbage; never mutates `raw`.
function recordImpact(raw, opts = {}) {
  if (!raw || typeof raw !== 'object') return null

  const category = str(raw.category)
  if (!category || !CATEGORIES.has(category)) return null

  // a missing unit defaults to a plain count; an UNKNOWN unit is a guess we won't make.
  const unit = raw.unit == null ? UNIT.COUNT : str(raw.unit)
  if (!unit || !UNITS.has(unit)) return null

  const value = roundValue(num(raw.value, 0), unit)
  if (!(value > 0)) return null            // no positive magnitude ⇒ not a win ⇒ not ledgered

  const minConf = clamp01(opts.minConfidence != null ? opts.minConfidence : DEFAULTS.minConfidence)
  const confidence = round2(clamp01(raw.confidence == null ? DEFAULTS.defaultConfidence : raw.confidence))
  if (confidence < minConf) return null

  return {
    category,
    client_id:      str(raw.client_id),
    client_name:    str(raw.client_name) || '',
    metric:         str(raw.metric),
    unit,
    value,
    confidence,
    weighted_value: round2(value * confidence),   // the risk-adjusted, defensible number
    occurred_at:    str(raw.occurred_at),
    detail:         str(raw.detail),
  }
}

// fully tie-broken so identical input ⇒ identical order (biggest proven win first)
function cmpEntries(a, b) {
  const wa = a.value * a.confidence, wb = b.value * b.confidence
  if (wb !== wa) return wb - wa
  if (b.value !== a.value) return b.value - a.value
  if (a.category !== b.category) return a.category < b.category ? -1 : 1
  const an = a.client_name || '', bn = b.client_name || ''
  if (an !== bn) return an < bn ? -1 : 1
  const ai = a.client_id || '', bi = b.client_id || ''
  if (ai !== bi) return ai < bi ? -1 : 1
  const am = a.metric || '', bm = b.metric || ''
  if (am !== bm) return am < bm ? -1 : 1
  if (a.unit !== b.unit) return a.unit < b.unit ? -1 : 1
  return 0
}

function cmpClients(a, b) {
  const pa = a.primary_unit ? UNIT_PRIORITY.indexOf(a.primary_unit) : 99
  const pb = b.primary_unit ? UNIT_PRIORITY.indexOf(b.primary_unit) : 99
  if (pa !== pb) return pa - pb
  if (b.rank_weight !== a.rank_weight) return b.rank_weight - a.rank_weight
  if (b.count !== a.count) return b.count - a.count
  const an = a.client_name || '', bn = b.client_name || ''
  if (an !== bn) return an < bn ? -1 : 1
  const ai = a.client_id || '', bi = b.client_id || ''
  if (ai !== bi) return ai < bi ? -1 : 1
  return 0
}

// ── aggregate a flat list of impact events into the full ledger ───────────────
function buildImpactLedger(events, opts = {}) {
  const list = Array.isArray(events) ? events : []
  const entries = []
  for (const e of list) {
    const rec = recordImpact(e, opts)
    if (rec) entries.push(rec)
  }
  entries.sort(cmpEntries)

  const by_unit = {}        // unit -> { value, weighted, count }   ← the only coherent totals
  const by_category = {}    // cat  -> { count, units: { unit -> { value, weighted } } }
  const clientMap = new Map()

  for (const r of entries) {
    const w = r.value * r.confidence

    const u = by_unit[r.unit] || (by_unit[r.unit] = { value: 0, weighted: 0, count: 0 })
    u.value += r.value; u.weighted += w; u.count += 1

    const c = by_category[r.category] || (by_category[r.category] = { count: 0, units: {} })
    c.count += 1
    const cu = c.units[r.unit] || (c.units[r.unit] = { value: 0, weighted: 0 })
    cu.value += r.value; cu.weighted += w

    const key = r.client_id || r.client_name || '∅'
    const cl = clientMap.get(key) ||
      { client_id: r.client_id, client_name: r.client_name, count: 0, units: {} }
    cl.count += 1
    const clu = cl.units[r.unit] || (cl.units[r.unit] = { value: 0, weighted: 0 })
    clu.value += r.value; clu.weighted += w
    clientMap.set(key, cl)
  }

  // finalize rounding (value rounds by unit, weighted is an expectation ⇒ 2dp)
  for (const [unit, u] of Object.entries(by_unit)) {
    u.value = roundValue(u.value, unit); u.weighted = round2(u.weighted)
  }
  for (const c of Object.values(by_category)) {
    for (const [unit, cu] of Object.entries(c.units)) {
      cu.value = roundValue(cu.value, unit); cu.weighted = round2(cu.weighted)
    }
  }

  const by_client = [...clientMap.values()].map(cl => {
    for (const [unit, cu] of Object.entries(cl.units)) {
      cu.value = roundValue(cu.value, unit); cu.weighted = round2(cu.weighted)
    }
    const primary_unit = UNIT_PRIORITY.find(u => cl.units[u]) || null
    const rank_weight = primary_unit ? cl.units[primary_unit].weighted : 0
    return {
      client_id: cl.client_id, client_name: cl.client_name,
      count: cl.count, units: cl.units, primary_unit, rank_weight,
    }
  })
  by_client.sort(cmpClients)

  // headline = the single unit carrying the most weighted value (dollars wins ties)
  let headline = null
  for (const [unit, u] of Object.entries(by_unit)) {
    const cand = { unit, value: u.value, weighted: u.weighted, count: u.count }
    if (!headline ||
        cand.weighted > headline.weighted ||
        (cand.weighted === headline.weighted &&
         UNIT_PRIORITY.indexOf(unit) < UNIT_PRIORITY.indexOf(headline.unit))) {
      headline = cand
    }
  }

  // effective confidence OF THE HEADLINE NUMBER — "how risk-adjusted is what we lead with"
  const confidence = headline && headline.value > 0
    ? round2(headline.weighted / headline.value)
    : null

  const provenMinEvents = num(opts.provenMinEvents, DEFAULTS.provenMinEvents)
  const provenMinConfidence = clamp01(
    opts.provenMinConfidence != null ? opts.provenMinConfidence : DEFAULTS.provenMinConfidence)
  const proven = !!headline &&
    entries.length >= provenMinEvents &&
    confidence != null && confidence >= provenMinConfidence

  return {
    count: entries.length,
    client_count: by_client.length,
    entries,
    by_unit,
    by_category,
    by_client,
    headline,
    confidence,
    proven,
    window: normalizeWindow(opts.window),
  }
}

// ── compact agency digest (for an endpoint / recap fold) ──────────────────────
function summarizeImpactLedger(ledger) {
  if (!ledger || typeof ledger !== 'object') {
    return { count: 0, client_count: 0, proven: false, headline: null, confidence: null, categories: [], units: [] }
  }
  return {
    count: num(ledger.count, 0),
    client_count: num(ledger.client_count, 0),
    proven: !!ledger.proven,
    headline: ledger.headline || null,
    confidence: ledger.confidence == null ? null : round2(ledger.confidence),
    categories: ledger.by_category ? Object.keys(ledger.by_category).sort() : [],
    units: ledger.by_unit ? Object.keys(ledger.by_unit).sort() : [],
  }
}

// ── one grounded sentence ─────────────────────────────────────────────────────
// agency: states the headline (risk-adjusted) number and whether it's proven yet.
// client: stays SILENT unless the record is proven, and even then says nothing
//         specific — no number, no client, no category. The real client surface is B4.
function narrateImpactLedger(ledger, opts = {}) {
  if (!ledger || !ledger.headline || !num(ledger.count, 0)) return ''
  const audience = opts.audience === 'client' ? 'client' : 'agency'

  if (audience === 'client') {
    return ledger.proven
      ? 'The work behind the scenes has been paying off — and the results are holding up.'
      : ''
  }

  const h = ledger.headline
  const wins = num(ledger.count, 0)
  const clients = num(ledger.client_count, 0)
  const acrossClients = clients > 1 ? ` across ${clients} clients` : ''
  const tail = ledger.proven ? ' — a proven track record' : ', and building a track record'
  const winWord = wins === 1 ? 'win' : 'wins'

  if (h.unit === UNIT.DOLLARS) {
    return `Intelligence has protected an estimated $${fmt(h.weighted)} in client goals across ${wins} ${winWord}${acrossClients}${tail}.`
  }
  return `Intelligence has delivered ${wins} measurable ${winWord}${acrossClients}${tail}.`
}

module.exports = {
  recordImpact,
  buildImpactLedger,
  summarizeImpactLedger,
  narrateImpactLedger,
  // constants — exported for tests + any consumer that wants the same taxonomy/thresholds
  CATEGORY, CATEGORIES, UNIT, UNITS, UNIT_PRIORITY, CATEGORY_META, DEFAULTS,
  // small pure helpers a couple of consumers/tests reuse
  num, clamp, clamp01, round2,
}
