'use strict'

// ============================================================
// lib/brief.js — orchestrate + persist ONE grounded "morning brief" per scope/day.
//
//   getClientPulse / getPortfolioPulse        (deterministic daily pulse)
//        → buildClientBriefPack / buildPortfolioBriefPack  (numbers-only pack)
//        → generateBriefText   (narrate-only LLM + grounding verifier + fallback)
//        → upsert into ai_briefs   (idempotent on scope_key, as_of)
//
// The daily analog of lib/recap.js. Where a recap narrates a completed WEEK for
// one client, a brief narrates a single DAY's pulse — for either audience. Two
// audiences share one table:
//   * a client brief   keyed on  scope_key = clientId          (audience 'client')
//   * the portfolio    keyed on  scope_key = '__portfolio__'   (audience 'agency')
// client_id is a reference-only column (NULL for the portfolio brief) and is
// never part of the key, because the portfolio brief has no single client.
//
// Idempotent by design: re-running a day overwrites in place via the
// PRIMARY KEY (scope_key, as_of) ON CONFLICT arbiter, so a morning job and a
// manual "regenerate" both converge on one row. Never throws on the AI path —
// generateBriefText already degrades to a deterministic, grounded template.
// ============================================================

const { query }                                          = require('../db')
const { getClientPulse, getPortfolioPulse }              = require('./insights')
const { buildClientBriefPack, buildPortfolioBriefPack }  = require('./pulseBrief')
const { summarizePortfolioPulse, summarizeClientPulse }  = require('./pulseBriefing')
const { generateBriefText }                              = require('./ai')
// intel-v7 layer 14 — watch the watcher. Pure, dependency-free (requires nothing,
// no ./brief cycle), so a top-level require is safe where briefImpactEngine /
// briefLeadPolicy must stay lazy. Used by the morning generators' self-healing gate
// and by leadPolicyHealthFor below.
const policyHealth                                       = require('./briefLeadPolicyHealth')
// intel-v7 layer 15 — the governor. Consumes policyHealth's verdict and returns the
// surgically-governed policy to apply (neutralise only oscillating lanes, hold saturated
// lanes at bound, respect the floor, pass healthy lanes through), superseding layer 14's
// blunt all-or-nothing revert. Pure and dependency-free, so a top-level require is safe.
const { governLeadPolicy }                               = require('./briefLeadPolicyGovernor')
// intel-v7 layer 16 — the auditor. Audits the governor's OWN decisions across mornings (does
// the safe corrective actually stick, or does the learner keep re-oscillating a lane the
// governor keeps neutralising?) and recommends escalation when it doesn't — the LEARN/ADJUST
// half that closes the governor's loop. Pure and dependency-free, so a top-level require is safe.
const leadAudit                                          = require('./briefLeadPolicyAudit')
// intel-v7 layer 17 — the remediator. Turns the auditor's `escalate` recommendation into a
// concrete bounded reversible structural fix (widen a lane's dead-band → tighten its bounds →
// pin it), staged for one agency click and never auto-applied — the ADJUST rung that gives the
// auditor's escalation a consumer and closes the loop SENSE→ACT→AUDIT→REMEDIATE. Pure and
// dependency-free, so a top-level require is safe.
const leadRemediation                                    = require('./briefLeadPolicyRemediation')

// The portfolio brief spans every client, so it has no client id to key on; it
// lives under this single reserved scope. Exported so the route layer and tests
// reference the one constant instead of re-typing the sentinel.
const PORTFOLIO_KEY = '__portfolio__'

// Calendar day the brief narrates. Today in UTC — byte-identical to the default
// day getClientPulse (via loadDailySeries) and getPortfolioPulse compute when
// asOf is omitted, so a read-without-generate keys on exactly the day a generate
// would have produced. A brief is a single DAY's pulse, so there is no Monday
// snap (that is the recap's week grain, not ours).
function defaultAsOf() {
  return new Date().toISOString().slice(0, 10)
}

const safeParse = (s) => { try { return JSON.parse(s) } catch { return {} } }

// `pack` reads back as a parsed object on Postgres (JSONB) but a JSON string on
// SQLite (TEXT); `grounded` as a boolean vs 0/1. Normalise both so callers get
// one stable shape regardless of backend (mirrors normalizeRecapRow).
function normalizeBriefRow(row) {
  if (!row) return null
  return {
    scope_key:  row.scope_key,
    as_of:      row.as_of,
    audience:   row.audience,
    client_id:  row.client_id,
    model:      row.model,
    brief_text: row.brief_text,
    grounded:   !!row.grounded,
    pack: typeof row.pack === 'string' ? safeParse(row.pack) : (row.pack || {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

// One upsert shape for both audiences and both backends. 1/0 for the
// BOOLEAN(pg)/INTEGER(sqlite) `grounded` column; JSON string for the JSONB/TEXT
// `pack` — the same cross-backend idiom as lib/recap.js / routes/connections.js.
async function upsertBrief({ scopeKey, asOf, audience, clientId, model, pack, text, grounded }) {
  await query(
    `INSERT INTO ai_briefs
       (scope_key, as_of, audience, client_id, model, pack, brief_text, grounded, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
     ON CONFLICT (scope_key, as_of) DO UPDATE SET
       audience   = EXCLUDED.audience,
       client_id  = EXCLUDED.client_id,
       model      = EXCLUDED.model,
       pack       = EXCLUDED.pack,
       brief_text = EXCLUDED.brief_text,
       grounded   = EXCLUDED.grounded,
       updated_at = CURRENT_TIMESTAMP`,
    [scopeKey, asOf, audience, clientId, model, JSON.stringify(pack), text, grounded ? 1 : 0]
  )
}

// Honest, client-safe reinforcement for the morning brief: ONE pre-narrated sentence,
// shown only when our recent morning leads have actually EARNED their place (editorial
// impact label 'earned'). Built from the SAME precision grade the agency sees, but the
// client never receives the grade itself — narrateBriefImpact's 'client' branch returns
// the trust sentence for 'earned' and '' for every other label, so 'fair'/'overcalled'/
// un-graded all collapse to '' and nothing is shown. We pass the OVERALL portfolio grade
// (largest sample → most robust), never a per-client bucket, and only the string crosses
// into the client-visible pack — never label, hit_rate, by_lane or by_audience.
//
// Fail-safe by construction: any error in the grading replay yields '' and the brief
// still ships. Lazy requires break a module cycle — briefImpactEngine requires ./brief
// (listRecentBriefs), so brief.js must not require it at load time; by call time both
// modules are fully resolved and the require cache makes repeat calls free.
async function clientImpactReinforcement(asOf) {
  try {
    const { getBriefImpact }     = require('./briefImpactEngine')
    const { narrateBriefImpact } = require('./briefImpact')
    const impact = await getBriefImpact({ asOf })
    return narrateBriefImpact(impact, { audience: 'client' }) || ''
  } catch {
    return ''
  }
}

// The TUNE half of the self-improving lead loop (intel-v7 layer 13). Reads the SAME
// editorial-precision grade clientImpactReinforcement narrates and turns it into a
// bounded per-lane nudge: deriveLeadPolicy converts each triage lane's recent hit_rate
// into a weight in [0.8, 1.2], floors act_now at >=1.0 (a learned-noisy emergency lane
// can never be DOWN-weighted — burying a real crisis is worse than crying wolf), and
// returns status 'tuned' ONLY when a graded lane actually crossed the min-sample bar.
// 'abstained' (ungraded) and 'idle' (graded, nothing moved yet) both leave the brief
// byte-identical to the live pulse, so the morning brief equals the dashboard until the
// loop has truly LEARNED something. Fail-safe by construction: any error in the grading
// replay yields null and the caller falls back to the untuned briefing. Same lazy-require
// cycle break as above (briefImpactEngine -> ./brief), and the require cache makes the
// second call in a single brief run free.
async function leadPolicyFor(asOf) {
  try {
    const { getBriefImpact }   = require('./briefImpactEngine')
    const { deriveLeadPolicy } = require('./briefLeadPolicy')
    const impact = await getBriefImpact({ asOf })
    return deriveLeadPolicy(impact)
  } catch {
    return null
  }
}

// ── intel-v9 layer 19b: close the engagement loop ────────────────────────────
// leadPolicyFor tunes WHICH lanes lead; this tunes HOW MANY supporting rows the
// portfolio brief carries — from the consumer's own reception. It reads the agency
// engagement aggregate (getPortfolioEngagement — every client's 👍/👎 over a trailing
// window rolled into one helpful_rate/label/trend) and turns it into a bounded
// supporting-cast cap (deriveBriefEmphasis): a well_received book EARNS a wider cast,
// a poorly_received or fading one tightens to the essentials, and the headline is never
// touched. Non-circular (mirrors pulseTuning): the grade measures yesterday's votes, the
// cap shapes tomorrow's brief — input never depends on output, so the controller is stable.
// Fail-safe by construction: any error — or a thin/missing grade — yields null/abstained
// and the caller falls back to the neutral cap of 3, byte-identical to today. Lazy requires
// keep load-time clean; the require cache makes the call free after the first.
async function briefEngagementEmphasisFor(asOf) {
  try {
    const { getPortfolioEngagement } = require('./briefEngagementEngine')
    const { deriveBriefEmphasis }    = require('./briefEngagementLearning')
    const engagement = await getPortfolioEngagement({ asOf })
    return deriveBriefEmphasis(engagement)
  } catch {
    return null
  }
}

// ── intel-v9 layer 20b: pair each engagement decision with its OWN follow-on ──
// Pure zip — no DB, no clock, never throws. Walks NORMALIZED portfolio brief rows
// (ascending by as_of, as listRecentBriefs returns them) and keeps only those that
// actually carried an engagement decision: pack.engagement_policy with a real
// `direction`. (An 'abstained' grade was never persisted — brief.js:425 — so a
// present policy means a move was MADE: widen, tighten, or hold neutral.) Consecutive
// kept rows then pair a decision with its outcome FOR FREE: row[i]'s decision
// (direction + the helpful_rate that drove it + the base_cap it flexed from) is graded
// by row[i+1]'s observed reception (its helpful_rate + sample n). No new query, no extra
// capture — the history is already on disk. The emitted shape is exactly what
// classifyEmphasisOutcome reads (briefEmphasisEfficacy header lines 52-58).
function buildEmphasisObservations(rows) {
  const policied = []
  for (const r of Array.isArray(rows) ? rows : []) {
    const pol = r && typeof r.pack === 'object' && r.pack ? r.pack.engagement_policy : null
    if (pol && typeof pol === 'object' && pol.direction) {
      policied.push({ as_of: r.as_of, policy: pol })
    }
  }
  const observations = []
  for (let i = 0; i + 1 < policied.length; i++) {
    const decision = policied[i].policy
    const outcome  = policied[i + 1].policy
    observations.push({
      as_of:       policied[i].as_of,
      direction:   decision.direction,
      rate_before: decision.helpful_rate,
      base_cap:    decision.base_cap,
      rate_after:  outcome.helpful_rate,
      n_after:     outcome.n,
    })
  }
  return observations
}

// ── intel-v9 layer 20b: measure whether the engagement loop's moves WORKED ────
// Layer 19 flexes the supporting-cast cap on every reception grade — widen when
// well-received, tighten when fading — but never checks whether the flex paid off.
// This reads the persisted portfolio history (PURE: listRecentBriefs never generates)
// and asks, per direction, did widening SUSTAIN reception and did tightening RECOVER it,
// against the control of mornings the brief held steady — then emits a bounded step-scale
// a future controller (layer 21) can feed back to make layer 19 self-improving. The whole
// chain downstream of the read is pure (buildEmphasisObservations + summarizeEmphasisEfficacy
// never throw, and an empty history yields a clean status:'insufficient', not an error), so
// the only throw source is the DB read itself — which the route's try/catch turns into a 500,
// exactly like its brief-engagement sibling. A longer default window than engagement's own
// reception snapshot (the route passes 90) lets enough decided outcomes accrue per direction
// before it grades. Lazy require keeps load-time clean; the require cache makes it free after.
async function briefEmphasisEfficacyFor(asOf, days) {
  const { summarizeEmphasisEfficacy } = require('./briefEmphasisEfficacy')
  const rows = await listRecentBriefs({ asOf, days, audience: 'agency', scopeKey: PORTFOLIO_KEY })
  return summarizeEmphasisEfficacy(buildEmphasisObservations(rows))
}

// ── intel-v9 layer 21b: scale layer 19's flex by its OWN measured efficacy ────
// Layer 19 turns the reception grade into a ±1 supporting-cast cap flex; layer 20 measures
// whether past flexes WORKED and emits a bounded step-scale per direction; THIS composes the
// two — applyEmphasisControl reads 20's verdict on the direction 19 just flexed and leans the
// magnitude one row further (efficacy endorsed) or eases it one row back (efficacy tempered),
// closing the second-order loop: reception → flex → efficacy → scaled flex. The CONTROLLED cap
// is what the brief actually uses, and the controlled decision is what we persist (below), so
// layer 20 keeps grading the breadth the brief genuinely went out with — never a mislabel.
// Fail-safe by construction, three ways: briefEngagementEmphasisFor is itself fail-safe (null
// on a thrown error, an abstained object on a thin grade); an abstained or null 19 grade
// short-circuits BEFORE any DB read and
// is handed back as-is so the caller's `status !== 'abstained'` persist gate still suppresses a
// thin morning; and if the (not-itself-fail-safe) efficacy read throws, we fall back to 19's
// un-controlled decision — byte-identical to a 19b-only morning — never propagating the throw.
// applyEmphasisControl is a pure module that never throws and is an exact identity pass-through
// whenever there is no flex to scale or no measured efficacy yet, so until the loop has data the
// controlled brief equals the 19-only brief. Uses the SAME default window the read endpoint
// reports (EMPHASIS_EFFICACY_WINDOW = 90) so the engine and the endpoint compute one identical
// controlled decision. Lazy require keeps load-time clean; the require cache makes it free after.
const EMPHASIS_EFFICACY_WINDOW = 90
async function briefEmphasisControlFor(asOf, days = EMPHASIS_EFFICACY_WINDOW) {
  const emphasis = await briefEngagementEmphasisFor(asOf)
  if (!emphasis || emphasis.status === 'abstained') return emphasis || null
  try {
    const { applyEmphasisControl } = require('./briefEmphasisControl')
    const efficacy = await briefEmphasisEfficacyFor(asOf, days)
    return applyEmphasisControl(emphasis, efficacy)
  } catch {
    return emphasis
  }
}

// ── intel-v9 layer 22: watch the CONTROLLER ──────────────────────────────────
// Layers 19→20→21 form a CLOSED control loop: 19 flexes the supporting-cast cap from
// reception, 20 measures whether the flex worked, 21 leans/eases the flex MAGNITUDE by that
// measurement. A closed loop can misbehave — HUNT (oscillate the breadth morning after
// morning) or SATURATE (pin the cap at a rail for days). Layer 22 watches the CONTROLLER
// itself: it reconstructs the trajectory of layer-21 decisions and classifies stability,
// carrying ONE self-healing action — 'damp' on hunting, the signal the morning generator
// consults to bench the controller and ship layer 19's UN-modulated cap until the thrash
// settles. The direct single-track sibling of layer 14's lead-policy monitor, on the
// engagement tower. Pure, dependency-free top-level require (mirrors policyHealth).
const controlHealth = require('./briefEmphasisControlHealth')

// briefEmphasisControlFor hands back ONE morning's controlled decision; the stability monitor
// needs the TRAJECTORY. emphasisControlHistoryFor walks the day-anchors of an inclusive window
// ending at `asOf`, OLDEST->NEWEST, replaying the controller that WOULD have been live each
// morning (each anchor re-composes 19+20+21 against that day's grades, so this reconstructs the
// real arc, not N copies of today). Each kept element is the controller superset spread under an
// { as_of, ... } wrapper — exactly the shape assessEmphasisControlHealth.normControl consumes (it
// reads also_cap/control_move/direction and tolerates the rare raw-emphasis fallback, which lacks
// control_move and so reads as a neutral 'none' move — never a false hunt). An abstained/null
// morning (thin or pre-loop grade) contributes nothing, so it reads as a gap, never a throw.
// span is clamped to [DEFAULT_MIN_HISTORY, CONTROL_HISTORY_SPAN_MAX]: two is the fewest the
// monitor will judge, fourteen caps the per-morning replay cost; the default is the monitor's own
// window so a once-daily generation mints exactly that many controller decisions to assess.
const CONTROL_HISTORY_SPAN_MAX = 14
function clampControlSpan(span) {
  if (span == null || span === '') return controlHealth.DEFAULT_WINDOW
  const n = Math.floor(Number(span))
  if (!Number.isFinite(n)) return controlHealth.DEFAULT_WINDOW
  return Math.max(controlHealth.DEFAULT_MIN_HISTORY, Math.min(CONTROL_HISTORY_SPAN_MAX, n))
}

async function emphasisControlHistoryFor(asOf, span) {
  const to  = asOf || defaultAsOf()
  const n   = clampControlSpan(span)
  const out = []
  for (let i = n - 1; i >= 0; i--) {
    const day = isoDayMinus(to, i)
    const ctl = await briefEmphasisControlFor(day)
    if (ctl && ctl.status !== 'abstained') out.push({ as_of: day, ...ctl })
  }
  return out
}

// The controller's stability verdict over that window — pure read, never throws
// (assessEmphasisControlHealth abstains on thin history). Used by the morning generator's
// self-healing damp gate AND the agency read endpoint; echoed nowhere to the client.
async function emphasisControlHealthFor(asOf, span) {
  return controlHealth.assessEmphasisControlHealth(await emphasisControlHistoryFor(asOf, span))
}

// Layer 22 self-heal projection. When the controller is benched for HUNTING, recover layer 19's
// UN-modulated decision from the controller superset (no extra read): the pre-control cap
// (emphasis_also_cap — layer 19's clamped flex before 21 touched it) becomes the shipped cap,
// the delta/direction/status are re-derived from it against base_cap, and the controller
// provenance is zeroed (control_move 'none', reason 'damped_unstable', step_scale null) so the
// persisted engagement_policy projection reads honestly as a 19-only morning. Pure and total:
// every numeric field has a Number-coerced fallback, and a fallback-shaped `controlled` (the rare
// raw-emphasis path, which has no emphasis_also_cap) already carries its own un-modulated also_cap,
// so reverting it is an idempotent no-op. Never throws.
function dampEmphasis(c) {
  const base     = Number(c.base_cap)
  const cap      = Number(c.emphasis_also_cap != null ? c.emphasis_also_cap : c.also_cap)
  const safeBase = Number.isFinite(base) ? base : cap
  const delta    = Number.isFinite(cap) ? cap - safeBase : 0
  const dir      = delta > 0 ? 'widen' : delta < 0 ? 'tighten' : 'neutral'
  return {
    ...c,
    status:         delta === 0 ? 'idle' : 'tuned',
    also_cap:       Number.isFinite(cap) ? cap : c.also_cap,
    delta,
    direction:      dir,
    control_move:   'none',
    control_reason: 'damped_unstable',
    step_scale:     null,
  }
}

// ── intel-v7 layer 14: watch the watcher ─────────────────────────────────────
// leadPolicyFor hands back ONE morning's policy; the stability monitor needs the
// TRAJECTORY. leadPolicyHistoryFor walks the day-anchors of an inclusive window
// ending at `asOf`, OLDEST->NEWEST, deriving the policy that WOULD have been live each
// morning (getBriefImpact is re-graded to each anchor, so this reconstructs the real
// arc, not N copies of today). Each kept element is a { as_of, policy } wrapper —
// exactly the shape briefLeadPolicyHealth.normSnapshot consumes, so newest.policy
// recovers the unmodified policy with no stripping. A morning whose grade errored
// contributes nothing (leadPolicyFor already returns null there) so it reads as a gap,
// never a throw. span is clamped to [DEFAULT_MIN_HISTORY, HISTORY_SPAN_MAX]: two is the
// fewest the monitor will judge, fourteen caps the per-morning replay cost; the default
// is the monitor's own window so a once-daily generation mints exactly that many grades.
const HISTORY_SPAN_MAX = 14
function clampSpan(span) {
  if (span == null || span === '') return policyHealth.DEFAULT_WINDOW
  const n = Math.floor(Number(span))
  if (!Number.isFinite(n)) return policyHealth.DEFAULT_WINDOW
  return Math.max(policyHealth.DEFAULT_MIN_HISTORY, Math.min(HISTORY_SPAN_MAX, n))
}

async function leadPolicyHistoryFor(asOf, span) {
  const to  = asOf || defaultAsOf()
  const n   = clampSpan(span)
  const out = []
  for (let i = n - 1; i >= 0; i--) {
    const day    = isoDayMinus(to, i)
    const policy = await leadPolicyFor(day)
    if (policy) out.push({ as_of: day, policy })
  }
  return out
}

// The stability verdict over that window — pure read, never throws (assessLeadPolicyHealth
// abstains on thin history). Used by the agency read endpoint AND echoed nowhere to the
// client. Fail-safe: any assembly error bubbles as an abstained-shaped throw only if
// leadPolicyFor itself were unsafe, which it is not.
async function leadPolicyHealthFor(asOf, span) {
  return policyHealth.assessLeadPolicyHealth(await leadPolicyHistoryFor(asOf, span))
}

// The governor's verdict over that window — what it corrected, held or floored on the live
// policy, and why. Pure read, never throws (governLeadPolicy abstains when there is no policy
// or the health is unassessable). Used by the agency read endpoint; echoed nowhere to the
// client. Reuses the single-pass decision so the window is assembled once, not again.
async function leadPolicyGovernanceFor(asOf, span) {
  const { governance } = await leadPolicyDecisionFor(asOf, span)
  return governance
}

// One pass that yields everything the morning generators need: the policy live at `asOf`
// (or null when its own grade errored), the stability verdict over the window, and the
// self-heal signal. The window is assembled ONCE here, not twice. `policy` is the newest
// snapshot ONLY when it actually lands on the target morning — a stale tail (the target
// day errored to null) must never masquerade as today's policy, so it falls back to null
// and the brief stays untuned. `governed` is what the generators actually apply: the LAYER-15
// governor consumes the stability verdict and returns the policy with only the unhealthy lanes
// corrected — superseding layer 14's blunt revert, which suppressed the WHOLE learned order the
// moment one lane oscillated. `governance` is the agency-only record of what it corrected;
// `revert` is retained for the read endpoint's back-compat signal but no longer gates apply.
async function leadPolicyDecisionFor(asOf, span) {
  const to         = asOf || defaultAsOf()
  const history    = await leadPolicyHistoryFor(to, span)
  const health     = policyHealth.assessLeadPolicyHealth(history)
  const revert     = policyHealth.shouldRevertToNeutral(health)
  const newest     = history.length ? history[history.length - 1] : null
  const policy     = (newest && newest.as_of === to) ? newest.policy : null
  // Layer 15: surgically govern the policy against its own stability verdict. On an oscillating
  // lane the governor neutralises ONLY that lane (lanes that earned their weight stay live); on
  // saturation it holds at bound (refuses to auto-widen); on a floor-mask it respects the floor.
  // healthy/abstained verdicts pass the policy through untouched — fail-safe by construction.
  const governance = governLeadPolicy(policy, health)
  const governed   = governance.governed
  return { policy, governed, governance, history, health, revert }
}

// intel-v7 layer 16 — the auditor's raw material. Reconstructs what the LAYER-15 governor
// decided on each of the trailing `span` mornings by replaying it over EXPANDING PREFIXES of
// ONE policy-history walk: morning i is governed against the stability verdict assessed from
// the snapshots up to and including i (assessLeadPolicyHealth windows internally, so the most
// recent mornings — the ones that drive escalation — get a full trailing window). This is O(n)
// in the expensive dimension (a single policy walk), not O(n²). The OLDEST mornings get thin
// prefixes, so the governor abstains there and the morning reads as non-correcting —
// deliberately CONSERVATIVE: the auditor can only UNDER-count corrections, never invent a
// spurious recurring run that would needlessly escalate to a human. Returns oldest→newest
// [{as_of, governance}], the morning shape auditLeadPolicyGovernance consumes directly. Default
// span is the AUDITOR's own window, so a once-daily generation mints exactly that many
// governance verdicts to audit (the same line-154 philosophy). Pure read, never throws.
async function leadPolicyGovernanceHistoryFor(asOf, span) {
  const n       = (span == null || span === '') ? leadAudit.DEFAULT_WINDOW : span
  const history = await leadPolicyHistoryFor(asOf, n)
  const out     = []
  for (let i = 0; i < history.length; i++) {
    const health     = policyHealth.assessLeadPolicyHealth(history.slice(0, i + 1))
    const governance = governLeadPolicy(history[i].policy, health)
    out.push({ as_of: history[i].as_of, governance })
  }
  return out
}

// intel-v7 layer 16 — the auditor's verdict. Audits the governor's own track record across
// those mornings: classifies each lane's intervention outcome (recurring/resolved/intermittent/
// one_off), rolls up to churning/effective/quiet/abstained, and recommends ESCALATION when the
// safe corrective keeps having to fire on the same lane (the learner re-oscillating faster than
// the governor neutralises). This is the LEARN/ADJUST half that closes the SENSE→ACT→LEARN→ADJUST
// loop. Agency-only calibration; echoed NOWHERE to the client. Pure read, never throws
// (auditLeadPolicyGovernance abstains on thin history).
async function leadPolicyGovernanceAuditFor(asOf, span) {
  return leadAudit.auditLeadPolicyGovernance(await leadPolicyGovernanceHistoryFor(asOf, span))
}

// intel-v7 layer 17 — the remediator's verdict. Reads the auditor's churning verdict over the
// trailing window AND the live derived policy, then — per churning, NON-floored lane — stages the
// least-aggressive bounded reversible structural fix (widen the dead-band → tighten the bounds →
// pin the lane), escalating by what's ALREADY been tried on that lane. This is the ADJUST rung
// that gives the auditor's `escalate` a concrete consumer, closing SENSE→ACT→AUDIT→REMEDIATE.
// Staged for one agency click, NEVER auto-applied; the safety floor (act_now) is never remediated.
// Agency-only calibration; echoed NOWHERE to the client. The audit is read over the requested
// span (its own window when absent); the policy is the live snapshot, span-invariant. Pure read,
// never throws (proposeLeadPolicyRemediation abstains when the audit abstains, is steady when it
// isn't escalating). Reuses the single-pass decision so the policy window is assembled once.
async function leadPolicyRemediationFor(asOf, span) {
  const audit      = await leadPolicyGovernanceAuditFor(asOf, span)
  const { policy } = await leadPolicyDecisionFor(asOf)
  return leadRemediation.proposeLeadPolicyRemediation(audit, policy)
}

/**
 * Build, narrate, verify and persist a client's morning brief for one day.
 * @param {string} clientId
 * @param {string} [asOf] 'YYYY-MM-DD'; defaults to today (UTC).
 * @returns {Promise<{scope_key,as_of,audience,client_id,model,brief_text,grounded,pack}>}
 */
async function generateClientBrief(clientId, asOf) {
  const day   = asOf || defaultAsOf()
  const pulse = await getClientPulse(clientId, { asOf: day })

  // TUNE the lead before packing. When the grade has learned that a lane earns its place,
  // summarizeClientPulse re-aims ONLY the headline/focus (counts/posture/confidence are
  // permutation-invariant and never move); otherwise this is a stable no-op and `briefing`
  // is the live pulse's own briefing, byte-identical to the dashboard. The CLIENT pack
  // never carries the policy object — only the re-aimed focus crosses the egress, never a
  // weight, hit_rate or lane label. pulse.signals is rankPulse(enriched), a pure sort, so
  // recomputing from it is set-identical to what getClientPulse already summarised.
  // SELF-GOVERNING GATE (layer 15): we apply the GOVERNED policy, not the raw one. The
  // governor has already neutralised any oscillating lane in place (a thrashing lane is
  // worse than no lane) while keeping the lanes that earned their weight live — superseding
  // layer 14's blunt revert, which dropped the WHOLE order the moment one lane wobbled. We
  // apply whenever the governed order still tunes something (status 'tuned'); if every lane
  // collapsed to neutral (status 'idle') this is a stable no-op. No governance or stability
  // field ever reaches the client pack; only the re-aimed focus crosses the egress.
  const { governed: leadPolicy } = await leadPolicyDecisionFor(day)
  const applyPolicy = !!(leadPolicy && leadPolicy.status === 'tuned')
  const briefing    = (applyPolicy && Array.isArray(pulse.signals))
    ? summarizeClientPulse(pulse.signals, { leadPolicy })
    : pulse.briefing
  const pack  = buildClientBriefPack({ ...pulse, briefing })
  const { text, model, grounded } = await generateBriefText(pack)

  // Honest reinforcement — only when our morning leads have EARNED it (else ''). Set
  // AFTER narration (LLM narrator + grounding verifier never see it) and BEFORE persist,
  // so it rides the same pack the client already reads. Client briefs only — the portfolio
  // brief is agency-facing and shows the full editorial-precision panel instead.
  pack.impact_reinforcement = await clientImpactReinforcement(day)

  await upsertBrief({
    scopeKey: clientId, asOf: day, audience: 'client', clientId,
    model, pack, text, grounded,
  })

  return {
    scope_key: clientId, as_of: day, audience: 'client', client_id: clientId,
    model, brief_text: text, grounded, pack,
  }
}

/**
 * Build, narrate, verify and persist the agency portfolio morning brief for one day.
 * @param {string} [asOf] 'YYYY-MM-DD'; defaults to today (UTC).
 */
async function generatePortfolioBrief(asOf) {
  const day   = asOf || defaultAsOf()
  const pulse = await getPortfolioPulse({ asOf: day })

  // TUNE the lead before packing (agency surface). When the grade has learned a lane
  // earns its place, summarizePortfolioPulse re-aims ONLY headline/also — counts, posture
  // and confidence are permutation-invariant and never move; otherwise this is a stable
  // no-op and `briefing` is the live pulse's own briefing. pulse.roster is rankPulse(roster),
  // a pure sort, so recomputing from it is set-identical to what getPortfolioPulse summarised.
  // SELF-GOVERNING GATE (layer 15): apply the GOVERNED order. The governor neutralises only
  // the oscillating lanes in place and keeps the earned ones live, superseding layer 14's
  // blunt all-or-nothing revert; the governance + health records below tell the agency WHAT
  // it corrected and WHY. Apply whenever the governed order still tunes something ('tuned').
  const { policy: rawPolicy, governed: leadPolicy, governance, health } = await leadPolicyDecisionFor(day)
  const applyPolicy = !!(leadPolicy && leadPolicy.status === 'tuned')
  // CLOSE THE ENGAGEMENT LOOP (layers 19b + 21b): tune the supporting-cast breadth from the
  // portfolio engagement grade (19), then scale that flex by its OWN measured efficacy (21).
  // briefEmphasisControlFor composes the two: layer 19 turns reception into a ±1 cap flex,
  // layer 20 measures whether past flexes WORKED, and layer 21 leans the magnitude one row
  // further (efficacy endorsed) or eases it one row back (efficacy tempered) — the second-
  // order loop. It is fail-safe (null on error / thin grade) and an exact identity pass-through
  // of layer 19's decision until the loop has measured efficacy, so the CONTROLLED cap equals
  // the 19-only cap until there is data to act on. A guaranteed no-op unless the (controlled)
  // grade EARNED a move (status 'tuned' → also_cap differs from base 3). Recompute the briefing
  // when EITHER the lead order OR the breadth changed: passing an idle/abstained leadPolicy is a
  // no-op (applyLeadPolicyToFeed) and an undefined alsoCap falls back to the neutral cap, so the
  // recompute stays set-identical to pulse.briefing except for whichever knob actually moved.
  // pulse.roster is a pure sort, so this is the same set summarizePortfolioPulse already
  // produced — only headline/also can re-aim. We feed the CONTROLLED cap (not the raw 19 flex)
  // so the brief ships the magnitude the loop actually endorses, and we persist that same
  // controlled decision below — layer 20 then grades the breadth the brief genuinely went out
  // with, never a mislabel, keeping the loop stable rather than self-reinforcing on a phantom.
  const controlled    = await briefEmphasisControlFor(day)
  // WATCH THE CONTROLLER (layer 22) + SELF-HEAL. Assess the layer-21 controller's OWN stability
  // over the trailing window. If it is HUNTING (oscillating the breadth morning after morning),
  // bench it for this morning: ship layer 19's UN-modulated cap instead of the thrashing
  // controlled cap — the controller's hands come off the wheel until the oscillation settles.
  // `effective` is the decision the brief actually ships AND the one we persist below, so layer 20
  // keeps grading the breadth that genuinely went out (damped or not), never a mislabel. Fail-safe:
  // emphasisControlHealthFor is a pure read over the same fail-safe controller, and any non-hunting
  // verdict (stable/settling/constrained/idle/abstained) leaves `controlled` untouched — the engine
  // behaves byte-identically to 21b until a hunt is actually proven over the window.
  const controlHealthVerdict = await emphasisControlHealthFor(day)
  const effective     = (controlHealth.shouldDampControl(controlHealthVerdict) && controlled)
    ? dampEmphasis(controlled) : controlled
  const applyEmphasis = !!(effective && effective.status === 'tuned')
  const briefing      = ((applyPolicy || applyEmphasis) && Array.isArray(pulse.roster))
    ? summarizePortfolioPulse(pulse.roster, { leadPolicy, alsoCap: applyEmphasis ? effective.also_cap : undefined })
    : pulse.briefing
  const pack  = buildPortfolioBriefPack({ ...pulse, briefing })
  const { text, model, grounded } = await generateBriefText(pack)

  // The learned-policy panel is AGENCY-ONLY telemetry (lane weights, hit_rates, what moved).
  // `leadPolicy` here is the GOVERNED order (the raw pre-governance order stays recoverable
  // from governance.snapshot). Set AFTER narration so the LLM narrator + grounding verifier
  // never see the machinery — mirrors clientImpactReinforcement's placement. Only ever
  // attached to the portfolio (agency) pack; the client pack carries no lead_policy (see
  // generateClientBrief). Gated on applyPolicy: a fully-collapsed ('idle') order is omitted.
  if (applyPolicy) pack.lead_policy = leadPolicy
  // GOVERN THE TUNER (layer 15): the governor's own record of what it corrected this morning
  // — which lanes it neutralised, held at bound or floored, and why. Agency-only, attached
  // whenever there was a policy to assess (status !== 'abstained'), INDEPENDENT of whether
  // the governed order applied — when every lane collapses, THIS explains the neutral order.
  // Supersedes layer 14's health verdict as the primary 'why'; we keep that too, just below.
  if (governance && governance.status !== 'abstained') pack.lead_policy_governance = governance
  // WATCH THE WATCHER (layer 14): the loop's own raw stability verdict — agency-only, attached
  // whenever there is enough history to judge (status !== 'abstained'), INDEPENDENT of whether
  // the policy applied. Set after narration so the narrator/verifier never see it, never on
  // the client pack. Retained alongside the governance record above for full diagnosis.
  if (health && health.status !== 'abstained') pack.lead_policy_health = health
  // REMEDIATE THE TUNER (layer 17): when the auditor finds the governor's safe corrective keeps
  // RECURRING on a lane (the learner re-oscillates faster than neutralise can keep up), the
  // remediator stages the least-aggressive bounded reversible structural fix for that lane —
  // widen its dead-band, tighten its bounds, or pin it — escalating by what's already been tried.
  // Reuses the raw (pre-governance) policy already in hand so only the audit walk is added. Agency-
  // only, attached ONLY when a fix is actually STAGED (a steady/abstained loop is omitted, mirroring
  // the governance gate above); the client pack never carries it. Staged for one agency click, never
  // auto-applied. Set after narration so the LLM narrator + grounding verifier never see it.
  const remediation = leadRemediation.proposeLeadPolicyRemediation(
    await leadPolicyGovernanceAuditFor(day), rawPolicy)
  if (leadRemediation.shouldStageRemediation(remediation)) pack.lead_policy_remediation = remediation
  // CLOSE THE ENGAGEMENT LOOP (layers 19b + 21b): the supporting-cast breadth the portfolio
  // engagement grade earned this morning — agency-only telemetry (also_cap vs base_cap, the
  // helpful_rate/label/trend that drove it, direction + reason). A SEPARATE loop from the
  // lead-policy tower above: that learns from our own editorial precision, this learns from
  // the consumer's reception. As of layer 21b we persist the CONTROLLED decision — layer 19's
  // raw flex AFTER layer 20's measured efficacy has scaled its magnitude — but ONLY its layer-19
  // cap-policy projection: the controlled status/cap/delta/direction that actually shipped, in the
  // exact deriveBriefEmphasis shape. We persist the controlled (not the raw) breadth DELIBERATELY:
  // the brief shipped the controlled cap, so layer 20 must grade THAT to stay honest — persisting
  // the raw 'widen' while the controller eased the cap back to neutral would mislabel a neutral
  // brief's reception as a widen outcome and let the loop self-reinforce on a phantom. We persist
  // ONLY the projection — NOT the controller provenance (control_move, control_reason, step_scale,
  // base/controlled step counts, emphasis_also_cap) — because that provenance is layer-20/21
  // vocabulary (`step_scale` is on the 20d FORBIDDEN_EFFICACY list) and is endpoint-only by the same
  // rule efficacy is: the agency reads it live from /brief-emphasis-control, it never rides the
  // serialized pack. The projection is the SAME 19b vocabulary that shipped before 21b, so this is
  // byte-identical to the 19b-only record whenever the controller is an identity pass-through.
  // Attached whenever the grade produced a real policy (status !== 'abstained'), INDEPENDENT of
  // whether the cap moved — an 'idle' grade still tells the agency "reception steady, holding
  // at 3". Set AFTER narration so the LLM narrator + grounding verifier never see the machinery;
  // never on the client pack (generateClientBrief carries none — the client only ever
  // experiences the EFFECT, a tighter or richer brief, never the second-order loop behind it).
  if (effective && effective.status !== 'abstained') {
    // Project the shipped decision's superset down to layer 19's engagement_policy shape. This is
    // `effective` — the controlled decision normally, or layer 19's UN-modulated decision when the
    // layer-22 monitor benched a hunting controller above — so what we persist is exactly the
    // breadth that went out, and layer 20 grades reality whether or not we damped. Field names are
    // identical to deriveBriefEmphasis except the reason, which the superset renames
    // `emphasis_reason`; the raw-emphasis fallback path (briefEmphasisControlFor's catch) keeps it
    // as `reason`, so accept either and never let it go undefined.
    pack.engagement_policy = {
      status:       effective.status,
      also_cap:     effective.also_cap,
      base_cap:     effective.base_cap,
      min_cap:      effective.min_cap,
      max_cap:      effective.max_cap,
      delta:        effective.delta,
      direction:    effective.direction,
      helpful_rate: effective.helpful_rate,
      label:        effective.label,
      trend:        effective.trend,
      n:            effective.n,
      reason:       effective.emphasis_reason != null ? effective.emphasis_reason
        : (effective.reason != null ? effective.reason : null),
    }
  }
  // WATCH THE CONTROLLER (layer 22): the controller's OWN stability verdict over the trailing
  // window drives the self-heal above (shouldDampControl → effective), but — exactly like the
  // layer-21 controller it watches — the verdict RIDES NO PACK, not even the agency/portfolio pack.
  // Its shape is dense with control vocabulary (control.moves.lean_in/ease_off, last_move, the
  // 'damp' recommended_action, verdict_reason 'control_hunting'): precisely the machinery the 21d
  // endpoint-only split keeps OUT of the serialized pack, so the LLM narrator + grounding verifier
  // never see it and no client egress can ever carry it. The agency reads it LIVE from
  // /brief-emphasis-control-health (emphasisControlHealthFor recomputes it fresh per request) — it
  // is surfaced, never persisted. The only trace it leaves on the brief is its EFFECT: the damped
  // `effective` breadth projected into engagement_policy above, which is pure layer-19 cap vocabulary.

  await upsertBrief({
    scopeKey: PORTFOLIO_KEY, asOf: day, audience: 'agency', clientId: null,
    model, pack, text, grounded,
  })

  return {
    scope_key: PORTFOLIO_KEY, as_of: day, audience: 'agency', client_id: null,
    model, brief_text: text, grounded, pack,
  }
}

// Read a stored brief without (re)generating. Returns null if none exists yet.
async function getBrief(scopeKey, asOf) {
  const day = asOf || defaultAsOf()
  const { rows } = await query(
    `SELECT * FROM ai_briefs WHERE scope_key = $1 AND as_of = $2`,
    [scopeKey, day]
  )
  return normalizeBriefRow(rows[0])
}

const getClientBrief    = (clientId, asOf) => getBrief(clientId, asOf)
const getPortfolioBrief = (asOf)           => getBrief(PORTFOLIO_KEY, asOf)

// Subtract n whole days from a 'YYYY-MM-DD' anchor, returning another 'YYYY-MM-DD'.
// Used only to compute the inclusive lower bound of the history window. Date math
// here (vs the pure briefQuality module) is consistent with defaultAsOf's own
// `new Date()` — the brief layer is the clock-aware boundary, the summarizer is not.
function isoDayMinus(ymd, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''))
  if (!m) return ymd
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - n * 86400000
  return new Date(t).toISOString().slice(0, 10)
}

// Window length in days, clamped to [1, 365]. BYTE-IDENTICAL to routes/ai.resolveDays
// so the lib defends exactly the way the route validates — a direct caller that skips
// the route (a morning job) gets the same window as an HTTP request would, and the
// echoed `requested.days` can never disagree with the span actually read. Null/blank/
// non-finite → the 30-day default; everything else floors then clamps (so 0 and -5 both
// become 1, not the surprising `0 || 30 → 30` an `|| default` would have produced).
function clampDays(days) {
  if (days == null || days === '') return 30
  const n = Math.floor(Number(days))
  if (!Number.isFinite(n)) return 30
  return Math.max(1, Math.min(365, n))
}

/**
 * Read recent persisted briefs for the narration-health audit (lib/briefQuality).
 * Returns NORMALIZED rows (pack parsed, grounded a real boolean) over an inclusive
 * day window ending at `asOf`, ascending by (as_of, scope_key) so the summarizer
 * sees a stable order. This is a pure read — it NEVER generates, so an audit can't
 * mint LLM calls or perturb the very history it grades.
 *
 * @param {object} [opts]
 * @param {string} [opts.asOf]    window end 'YYYY-MM-DD'; defaults to today (UTC).
 * @param {number} [opts.days=30] window length in days (clamped to 1..365).
 * @param {string} [opts.audience] optional 'client' | 'agency' filter.
 * @param {string} [opts.scopeKey] optional single-scope filter (a clientId or PORTFOLIO_KEY).
 * @returns {Promise<Array>} normalized brief rows (possibly empty).
 */
async function listRecentBriefs({ asOf, days = 30, audience, scopeKey } = {}) {
  const to    = asOf || defaultAsOf()
  const win   = clampDays(days)
  const from  = isoDayMinus(to, win - 1)

  const clauses = ['as_of >= $1', 'as_of <= $2']
  const params  = [from, to]
  if (audience) { params.push(audience); clauses.push(`audience = $${params.length}`) }
  if (scopeKey) { params.push(scopeKey); clauses.push(`scope_key = $${params.length}`) }

  const { rows } = await query(
    `SELECT * FROM ai_briefs
      WHERE ${clauses.join(' AND ')}
      ORDER BY as_of ASC, scope_key ASC`,
    params
  )
  return rows.map(normalizeBriefRow)
}

// Return the stored brief if present, else generate + persist one. Used by the
// in-app brief card route so the LLM is called at most once per scope per day.
async function getOrGenerateClientBrief(clientId, asOf) {
  const existing = await getClientBrief(clientId, asOf)
  if (existing && existing.brief_text) return existing
  return generateClientBrief(clientId, asOf)
}

async function getOrGeneratePortfolioBrief(asOf) {
  const existing = await getPortfolioBrief(asOf)
  if (existing && existing.brief_text) return existing
  return generatePortfolioBrief(asOf)
}

module.exports = {
  generateClientBrief,
  generatePortfolioBrief,
  getClientBrief,
  getPortfolioBrief,
  getOrGenerateClientBrief,
  getOrGeneratePortfolioBrief,
  listRecentBriefs,
  buildEmphasisObservations,
  briefEmphasisEfficacyFor,
  emphasisControlHistoryFor,
  emphasisControlHealthFor,
  leadPolicyHistoryFor,
  leadPolicyHealthFor,
  leadPolicyGovernanceFor,
  leadPolicyGovernanceHistoryFor,
  leadPolicyGovernanceAuditFor,
  leadPolicyRemediationFor,
  leadPolicyDecisionFor,
  defaultAsOf,
  PORTFOLIO_KEY,
}
