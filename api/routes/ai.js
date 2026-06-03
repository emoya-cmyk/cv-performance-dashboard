'use strict'

// ============================================================
// routes/ai.js — the Grounded-AI HTTP surface.
//
//   GET  /api/ai/recap/:clientId[?week=YYYY-MM-DD]
//        Read the stored recap, generating + persisting it on first access
//        (getOrGenerateRecap → the LLM is called at most once per client-week).
//        This is what the in-app recap card hits.
//
//   POST /api/ai/recap/:clientId[?week=YYYY-MM-DD]   (week may also be in body)
//        Force a fresh recap and overwrite the stored row — the "Regenerate"
//        button. Always re-narrates + re-verifies.
//
//   GET  /api/ai/brief/:clientId[?as_of=YYYY-MM-DD]
//   POST /api/ai/brief/:clientId[?as_of=YYYY-MM-DD]
//        The daily analog of the recap: a client's grounded "morning brief" over
//        one day's pulse. GET is generated-on-miss (once per client-day); POST
//        force-regenerates. See lib/brief.js + lib/pulseBrief.js.
//
//   GET  /api/ai/brief[?as_of=YYYY-MM-DD]
//   POST /api/ai/brief[?as_of=YYYY-MM-DD]
//        The agency portfolio morning brief (the whole book's pulse). AGENCY-ONLY
//        — the prose names other clients — so a client-scoped token is refused.
//
//   GET  /api/ai/brief-health[?days=N][?as_of=YYYY-MM-DD]
//        Narration-reliability self-grade: read the recent stored briefs (a pure,
//        non-generating read) and report, among the NARRATABLE ones, how many the
//        model actually wrote vs fell back to the safe template — plus the always-
//        on grounding invariant. AGENCY-ONLY: it names the machinery (models, fall-
//        back streaks) a client must never see. See lib/briefQuality.js.
//
//   POST /api/ai/ask   { question }
//        Natural-language portfolio queries. The question is parsed into a typed,
//        whitelisted query-spec, compiled to parameterised SQL (never text→SQL),
//        executed for deterministic numbers, then optionally narrated under the
//        same grounding verifier as the recap. See lib/ask.js for the full model.
//
// Mounted behind requireAuth in server.js, so every handler runs authenticated.
// The recap layer never throws on the AI path (it degrades to a deterministic
// template), so 5xx here only ever means a DB/transport fault.
// ============================================================

const express = require('express')
const { query } = require('../db')
const { weekStartOf } = require('../lib/rollup')
const { generateRecap, getOrGenerateRecap } = require('../lib/recap')
const {
  generateClientBrief, generatePortfolioBrief,
  getOrGenerateClientBrief, getOrGeneratePortfolioBrief,
  listRecentBriefs, leadPolicyHealthFor, leadPolicyGovernanceFor,
  leadPolicyGovernanceAuditFor, leadPolicyRemediationFor,
} = require('../lib/brief')
const { summarizeBriefQuality, narrateBriefHealth } = require('../lib/briefQuality')
const { assessBriefDelivery, narrateBriefDelivery } = require('../lib/briefDelivery')
const { getBriefImpact } = require('../lib/briefImpactEngine')
const { narrateBriefImpact } = require('../lib/briefImpact')
const { deriveLeadPolicy, narrateLeadPolicy } = require('../lib/briefLeadPolicy')
const { narrateLeadPolicyHealth } = require('../lib/briefLeadPolicyHealth')
const { narrateLeadPolicyGovernance } = require('../lib/briefLeadPolicyGovernor')
const { narrateLeadPolicyGovernanceAudit } = require('../lib/briefLeadPolicyAudit')
const { narrateLeadPolicyRemediation } = require('../lib/briefLeadPolicyRemediation')
const {
  recordBriefFeedback, getClientBriefFeedback, getPortfolioEngagement,
} = require('../lib/briefEngagementEngine')
const { narrateBriefEngagement } = require('../lib/briefEngagement')
const { deriveBriefEmphasis, narrateBriefEmphasis } = require('../lib/briefEngagementLearning')
const { runAsk, runSuggestions, runExplain } = require('../lib/ask')

const router = express.Router()

// Normalise a caller-supplied week to its Monday. Returns:
//   { week: 'YYYY-MM-DD' }  when a valid date was given,
//   { week: undefined }     when absent (recap layer defaults to last week),
//   { error: '…' }          when present but malformed.
function resolveWeek(raw) {
  if (raw == null || raw === '') return { week: undefined }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(raw))) {
    return { error: 'week must be an ISO date (YYYY-MM-DD)' }
  }
  return { week: weekStartOf(String(raw)) }  // snap to the Monday of that week
}

// A brief is keyed on a single calendar DAY (the pulse's as_of), not a week — so
// unlike resolveWeek there is NO Monday snap. Returns:
//   { asOf: 'YYYY-MM-DD' }  when a valid date was given,
//   { asOf: undefined }     when absent (brief layer defaults to today, UTC),
//   { error: '…' }          when present but malformed.
function resolveAsOf(raw) {
  if (raw == null || raw === '') return { asOf: undefined }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(raw))) {
    return { error: 'as_of must be an ISO date (YYYY-MM-DD)' }
  }
  return { asOf: String(raw) }
}

// History-window length for the narration-health audit. A lenient tuning knob, not a
// key: absent or unparseable → the 30-day default; otherwise clamped to [1, 365]. This
// MIRRORS the same clamp inside lib/brief.listRecentBriefs (defence-in-depth — the route
// validates the request, the lib defends regardless), and we pass the resolved value in
// so the echoed `requested.days` can never disagree with the window actually read.
function resolveDays(raw) {
  if (raw == null || raw === '') return 30
  const n = Math.floor(Number(raw))
  if (!Number.isFinite(n)) return 30
  return Math.max(1, Math.min(365, n))
}

// The portfolio brief is narrated prose that NAMES other clients (headline +
// "also" lines), so — unlike the openly-readable raw GET /pulse roster — only an
// explicit agency token may ever read it; any client-scoped token is refused.
// Mirrors the allow-list posture of resolveAskScope (agency role is the gate).
function resolvePortfolioScope(req) {
  const user = req.user || {}
  if (user.role === 'agency') return {}
  return { error: 'not authorized for the portfolio brief', status: 403 }
}

// Recaps FK-reference clients(id); generating one for an unknown client would
// trip the foreign key at insert time. Check up front so we can 404 cleanly.
async function clientExists(clientId) {
  const { rows } = await query(`SELECT id FROM clients WHERE id = $1`, [clientId])
  return rows.length > 0
}

// Derive the HARD client boundary for an ask from the authenticated token —
// never from a body param a caller could forge to widen their own view. The
// posture is an allow-list: only an explicit `agency` role may ever see across
// clients; every other token is pinned to its own client_id or refused.
//   agency role → may optionally narrow to one client via clientId (body for the
//                 POST ask, query for the GET suggestions; must exist → 404);
//                 absent → the whole book (null scope).
//   any other   → hard-pinned to its own token client_id; the body's clientId is
//                 ignored. No client_id on a non-agency token is a broken account
//                 that can't be safely scoped → 403.
// lib/ask.js re-enforces this id at compile time, so even a spec that tries to
// group_by:'client' or names a different client collapses to the scoped total —
// this route check and that compile check are defence-in-depth for each other.
async function resolveAskScope(req) {
  const user = req.user || {}
  if (user.role === 'agency') {
    const wanted = req.body?.clientId ?? req.query?.clientId
    if (wanted != null && wanted !== '') {
      if (!(await clientExists(wanted))) return { error: 'client not found', status: 404 }
      return { scopeClientId: wanted }
    }
    return { scopeClientId: null }  // whole book
  }
  if (user.client_id) return { scopeClientId: user.client_id }
  return { error: 'not authorized for portfolio queries', status: 403 }
}

// The brief-feedback WRITE and own-vote READ are a CONSUMER action: a client rates
// THEIR OWN morning brief. The clientId is therefore taken ONLY from the authenticated
// token — never a body/query param a caller could forge to vote as (or read) another
// client. An agency token carries no client_id (it is scoped by role, not to one
// client) and has no own-brief to rate, so it is refused here; the agency instead reads
// the AGGREGATE via GET /brief-engagement (resolvePortfolioScope). This is the privacy
// twin of resolveAskScope's non-agency branch, narrowed to a pure token-scope (no body).
function resolveConsumerScope(req) {
  const user = req.user || {}
  if (user.client_id) return { clientId: user.client_id }
  return { error: 'brief feedback is recorded from a client session', status: 403 }
}

// ── GET /api/ai/recap/:clientId ───────────────────────────────────────────────
// Stored recap, generated-on-miss. Idempotent and cheap on repeat hits.
router.get('/recap/:clientId', async (req, res) => {
  const { clientId } = req.params
  const { week, error } = resolveWeek(req.query.week)
  if (error) return res.status(400).json({ error })

  try {
    if (!(await clientExists(clientId))) {
      return res.status(404).json({ error: 'client not found' })
    }
    const recap = await getOrGenerateRecap(clientId, week)
    res.json(recap)
  } catch (err) {
    console.error('[ai] GET recap error', err.message)
    res.status(500).json({ error: 'Failed to load recap' })
  }
})

// ── POST /api/ai/recap/:clientId ──────────────────────────────────────────────
// Force regenerate + overwrite. Accepts ?week=… or { week } in the body.
router.post('/recap/:clientId', async (req, res) => {
  const { clientId } = req.params
  const { week, error } = resolveWeek(req.query.week ?? req.body?.week)
  if (error) return res.status(400).json({ error })

  try {
    if (!(await clientExists(clientId))) {
      return res.status(404).json({ error: 'client not found' })
    }
    const recap = await generateRecap(clientId, week)
    res.json(recap)
  } catch (err) {
    console.error('[ai] POST recap error', err.message)
    res.status(500).json({ error: 'Failed to generate recap' })
  }
})

// ── GET /api/ai/brief/:clientId ───────────────────────────────────────────────
// A client's grounded morning brief for one day, generated-on-miss
// (getOrGenerateClientBrief → the LLM is called at most once per client-day).
// Idempotent and cheap on repeat hits. ?as_of=YYYY-MM-DD selects the day; absent
// → today (UTC). This is what the in-app client brief card hits.
router.get('/brief/:clientId', async (req, res) => {
  const { clientId } = req.params
  const { asOf, error } = resolveAsOf(req.query.as_of)
  if (error) return res.status(400).json({ error })

  try {
    if (!(await clientExists(clientId))) {
      return res.status(404).json({ error: 'client not found' })
    }
    const brief = await getOrGenerateClientBrief(clientId, asOf)
    res.json(brief)
  } catch (err) {
    console.error('[ai] GET brief error', err.message)
    res.status(500).json({ error: 'Failed to load brief' })
  }
})

// ── POST /api/ai/brief/:clientId ──────────────────────────────────────────────
// Force a fresh client brief and overwrite the stored row — the "Regenerate"
// button. Always re-narrates + re-verifies. Accepts ?as_of=… or { as_of } in body.
router.post('/brief/:clientId', async (req, res) => {
  const { clientId } = req.params
  const { asOf, error } = resolveAsOf(req.query.as_of ?? req.body?.as_of)
  if (error) return res.status(400).json({ error })

  try {
    if (!(await clientExists(clientId))) {
      return res.status(404).json({ error: 'client not found' })
    }
    const brief = await generateClientBrief(clientId, asOf)
    res.json(brief)
  } catch (err) {
    console.error('[ai] POST brief error', err.message)
    res.status(500).json({ error: 'Failed to generate brief' })
  }
})

// ── GET /api/ai/brief ─────────────────────────────────────────────────────────
// The agency portfolio morning brief, generated-on-miss. AGENCY-ONLY: the prose
// names other clients, so a client-scoped token is refused (resolvePortfolioScope).
// ?as_of=YYYY-MM-DD selects the day; absent → today (UTC).
router.get('/brief', async (req, res) => {
  const scope = resolvePortfolioScope(req)
  if (scope.error) return res.status(scope.status).json({ error: scope.error })
  const { asOf, error } = resolveAsOf(req.query.as_of)
  if (error) return res.status(400).json({ error })

  try {
    const brief = await getOrGeneratePortfolioBrief(asOf)
    res.json(brief)
  } catch (err) {
    console.error('[ai] GET portfolio brief error', err.message)
    res.status(500).json({ error: 'Failed to load brief' })
  }
})

// ── POST /api/ai/brief ────────────────────────────────────────────────────────
// Force-regenerate the agency portfolio brief and overwrite the stored row.
// AGENCY-ONLY. Accepts ?as_of=… or { as_of } in the body.
router.post('/brief', async (req, res) => {
  const scope = resolvePortfolioScope(req)
  if (scope.error) return res.status(scope.status).json({ error: scope.error })
  const { asOf, error } = resolveAsOf(req.query.as_of ?? req.body?.as_of)
  if (error) return res.status(400).json({ error })

  try {
    const brief = await generatePortfolioBrief(asOf)
    res.json(brief)
  } catch (err) {
    console.error('[ai] POST portfolio brief error', err.message)
    res.status(500).json({ error: 'Failed to generate brief' })
  }
})

// ── GET /api/ai/brief-health ──────────────────────────────────────────────────
// Narration-reliability self-grade over the recent brief history. AGENCY-ONLY: it
// names the internal machinery (model ids, fallback streaks) a client must never see,
// so it shares the portfolio-brief 403 posture (resolvePortfolioScope). ?days=N tunes
// the look-back (default 30, clamped 1..365); ?as_of=YYYY-MM-DD anchors the window end
// (default today, UTC). The read is PURE — listRecentBriefs never (re)generates — so an
// audit can't mint LLM calls or perturb the very history it grades. We return the full
// summarizeBriefQuality shape (overall + per-audience buckets, grounded invariant), echo
// the requested window, and attach one agency-voiced narration sentence off the overall
// bucket. coverage (model !== 'template') and grounded_rate stay ORTHOGONAL by design —
// "is the AI still writing?" vs "are the numbers still verified?" — never conflated.
router.get('/brief-health', async (req, res) => {
  const scope = resolvePortfolioScope(req)
  if (scope.error) return res.status(scope.status).json({ error: scope.error })
  const { asOf, error } = resolveAsOf(req.query.as_of)
  if (error) return res.status(400).json({ error })
  const days = resolveDays(req.query.days)

  try {
    const rows    = await listRecentBriefs({ asOf, days })
    const summary = summarizeBriefQuality(rows)
    // summarizeBriefQuality GRADES (a standing pull); assessBriefDelivery turns that grade
    // into a VERDICT an agency surface + the Monday digest can act on — silent on healthy,
    // a worst-of-two-audience alarm with a self-heal step when the narrator is failing.
    // Agency-only by construction: this whole route is 403-gated, and the verdict's own
    // narration is agency-voiced (client → '').
    const signal = assessBriefDelivery(summary)
    res.json({
      ...summary,
      requested: { as_of: asOf || null, days },
      narrative: narrateBriefHealth(summary.overall, { audience: 'agency' }),
      delivery: { ...signal, narrative: narrateBriefDelivery(signal, { audience: 'agency' }) },
    })
  } catch (err) {
    console.error('[ai] GET brief-health error', err.message)
    res.status(500).json({ error: 'Failed to load brief health' })
  }
})

// GET /api/ai/brief-impact (agency-only) — the editorial-PRECISION read. brief-health
// asks "is the narrator still WRITING, and are the numbers VERIFIED?" (mechanics +
// reliability); brief-impact asks the orthogonal third question — "when we put something
// at the TOP of the brief, did the move we flagged actually HOLD UP over the next few
// mornings, or are we overcalling?" It replays the same self-tuning day-pulse sensor
// over the mornings that FOLLOWED each shipped lead and grades the lead earned/fair/
// overcalled with zero human review. Agency-only by construction: the verdict names a
// tighten-lead-selection action and exposes by_lane/by_audience grading no client should
// read, so the route is 403-gated and the narration is agency-voiced.
router.get('/brief-impact', async (req, res) => {
  const scope = resolvePortfolioScope(req)
  if (scope.error) return res.status(scope.status).json({ error: scope.error })
  const { asOf, error } = resolveAsOf(req.query.as_of)
  if (error) return res.status(400).json({ error })
  const days = resolveDays(req.query.days)

  try {
    const impact = await getBriefImpact({ asOf, days })
    res.json({
      ...impact,
      requested: { as_of: asOf || null, days },
      narrative: narrateBriefImpact(impact, { audience: 'agency' }),
    })
  } catch (err) {
    console.error('[ai] GET brief-impact error', err.message)
    res.status(500).json({ error: 'Failed to load brief impact' })
  }
})

// ── GET /api/ai/lead-policy ─────────────────────────────────────────────────────
// The TUNE half of the self-improving lead loop. brief-impact (above) MEASURES whether
// shipped leads held up; this turns that same editorial-precision grade into the bounded
// per-lane policy the morning brief actually applies — each triage lane's recent hit_rate
// becomes a weight in [0.8, 1.2], with act_now FLOORED at >=1.0 so a learned-noisy
// emergency lane can never be down-weighted (burying a real crisis is worse than crying
// wolf). status is 'tuned' only when a graded lane crossed the min-sample bar; 'idle' /
// 'abstained' mean the brief stays byte-identical to the live pulse. Agency-only by
// construction — the policy exposes lane weights, hit_rates and what moved, machinery no
// client should read — so it shares brief-impact's 403 gate and agency-voiced narration.
router.get('/lead-policy', async (req, res) => {
  const scope = resolvePortfolioScope(req)
  if (scope.error) return res.status(scope.status).json({ error: scope.error })
  const { asOf, error } = resolveAsOf(req.query.as_of)
  if (error) return res.status(400).json({ error })
  const days = resolveDays(req.query.days)

  try {
    const policy = deriveLeadPolicy(await getBriefImpact({ asOf, days }))
    res.json({
      ...policy,
      requested: { as_of: asOf || null, days },
      narrative: narrateLeadPolicy(policy, { audience: 'agency' }),
    })
  } catch (err) {
    console.error('[ai] GET lead-policy error', err.message)
    res.status(500).json({ error: 'Failed to load lead policy' })
  }
})

// ── GET /api/ai/lead-policy-health ──────────────────────────────────────────────
// WATCH THE WATCHER. /lead-policy (above) TUNES the lead loop; this judges whether that
// loop is still trustworthy or has begun chasing its own tail. It reads a HISTORY of the
// recent daily policies and flags three pathologies a single snapshot hides — oscillation
// (a lane flips promote<->demote morning after morning), saturation (a weight pinned at the
// ±20% bound for days), floor-masking (the act_now safety floor catching the same lane run
// after run, an overcall the valve is hiding) — and carries ONE self-healing action:
// 'revert_to_neutral' on oscillation, the SAME signal the morning generators consult before
// they apply the policy (lib/brief.leadPolicyDecisionFor). Pure agency calibration — lane
// weights, what's thrashing, what we suppressed — so it shares the 403 gate and agency-voiced
// narration. ?days=N sizes the history window (mornings of policy to assess); absent → the
// monitor's own default window, so a plain GET mints exactly that many deterministic grades.
router.get('/lead-policy-health', async (req, res) => {
  const scope = resolvePortfolioScope(req)
  if (scope.error) return res.status(scope.status).json({ error: scope.error })
  const { asOf, error } = resolveAsOf(req.query.as_of)
  if (error) return res.status(400).json({ error })
  // Pass the span through ONLY when explicitly requested; otherwise let leadPolicyHealthFor
  // fall to the monitor's window (assembling 30 anchors would mint 30 sequential grades).
  const span = (req.query.days == null || req.query.days === '') ? undefined : resolveDays(req.query.days)

  try {
    const health = await leadPolicyHealthFor(asOf, span)
    res.json({
      ...health,
      requested: { as_of: asOf || null, days: health.window_used },
      narrative: narrateLeadPolicyHealth(health, { audience: 'agency' }),
    })
  } catch (err) {
    console.error('[ai] GET lead-policy-health error', err.message)
    res.status(500).json({ error: 'Failed to load lead policy health' })
  }
})

// ── GET /api/ai/lead-policy-governance ──────────────────────────────────────────
// CLOSE THE LOOP. /lead-policy TUNES the lead loop, /lead-policy-health JUDGES it; this is
// what the morning brief now ACTS on. The governor consumes that same stability verdict and
// autonomously applies the safe corrective to the live policy — neutralising ONLY an
// oscillating lane (the lanes that earned their weight stay live), holding a saturated lane
// at its bound, and respecting the act_now floor — superseding layer 14's blunt, whole-policy
// revert. It returns the governed order the morning generators now apply, plus the per-lane
// record of what it corrected and why (interventions, counts, the pre-governance snapshot).
// Pure agency calibration — governed weights, what was neutralised/held/floored — so it shares
// the 403 gate and agency-voiced narration. ?days=N sizes the window assessed; absent → the
// monitor's own default, so a plain GET mints exactly that many deterministic grades to govern.
router.get('/lead-policy-governance', async (req, res) => {
  const scope = resolvePortfolioScope(req)
  if (scope.error) return res.status(scope.status).json({ error: scope.error })
  const { asOf, error } = resolveAsOf(req.query.as_of)
  if (error) return res.status(400).json({ error })
  // Same span discipline as /lead-policy-health: pass through only when explicitly requested,
  // otherwise let the single-pass decision fall to the monitor's own window.
  const span = (req.query.days == null || req.query.days === '') ? undefined : resolveDays(req.query.days)

  try {
    const governance = await leadPolicyGovernanceFor(asOf, span)
    res.json({
      ...governance,
      requested: { as_of: asOf || null, days: span ?? null },
      narrative: narrateLeadPolicyGovernance(governance, { audience: 'agency' }),
    })
  } catch (err) {
    console.error('[ai] GET lead-policy-governance error', err.message)
    res.status(500).json({ error: 'Failed to load lead policy governance' })
  }
})

// ── GET /api/ai/lead-policy-governance-audit ────────────────────────────────────
// CLOSE THE GOVERNOR'S OWN LOOP. /lead-policy-governance ACTS every morning — it applies the
// safe corrective autonomously — but it never audits its OWN track record. This does: it replays
// the governor across the trailing window of mornings and asks, per lane, whether the corrective
// STUCK (resolved), keeps recurring (the learner re-oscillates faster than the governor can
// neutralise it → churning), or only ever fired once. When a lane is churning it recommends
// ESCALATION — pin the lane or take a closer look — because the safe auto-corrective alone is no
// longer keeping up. This is the LEARN/ADJUST half that closes the SENSE→ACT→LEARN→ADJUST loop.
// Pure agency calibration, so it shares the 403 gate and agency-voiced narration. ?days=N sizes
// how many governance mornings to audit; absent → the auditor's own window, so a plain GET mints
// exactly that many deterministic verdicts to audit.
router.get('/lead-policy-governance-audit', async (req, res) => {
  const scope = resolvePortfolioScope(req)
  if (scope.error) return res.status(scope.status).json({ error: scope.error })
  const { asOf, error } = resolveAsOf(req.query.as_of)
  if (error) return res.status(400).json({ error })
  // Same span discipline as the sibling lead-policy reads: pass through only when explicitly
  // requested, otherwise let leadPolicyGovernanceAuditFor fall to the auditor's own window.
  const span = (req.query.days == null || req.query.days === '') ? undefined : resolveDays(req.query.days)

  try {
    const audit = await leadPolicyGovernanceAuditFor(asOf, span)
    res.json({
      ...audit,
      requested: { as_of: asOf || null, days: audit.window_used ?? (span ?? null) },
      narrative: narrateLeadPolicyGovernanceAudit(audit, { audience: 'agency' }),
    })
  } catch (err) {
    console.error('[ai] GET lead-policy-governance-audit error', err.message)
    res.status(500).json({ error: 'Failed to load lead policy governance audit' })
  }
})

// ── GET /api/ai/lead-policy-governance-remediation ────────────────────────────
// The ADJUST rung that closes the lead-policy loop: when the auditor escalates a
// recurring neutralize correction, the remediator turns that escalation into a
// concrete, bounded, reversible structural fix (widen dead-band → tighten bounds
// → pin neutral), staged for one agency click. Pure agency calibration, so it
// reuses the same 403 gate and agency-only narration; the client never sees any
// of this. ?days=N sizes how many governance mornings to audit before proposing;
// absent → the auditor's own window.
router.get('/lead-policy-governance-remediation', async (req, res) => {
  const scope = resolvePortfolioScope(req)
  if (scope.error) return res.status(scope.status).json({ error: scope.error })
  const { asOf, error } = resolveAsOf(req.query.as_of)
  if (error) return res.status(400).json({ error })
  // Same span discipline as the sibling lead-policy reads: pass through only when
  // explicitly requested, otherwise let the auditor inside fall to its own window.
  const span = (req.query.days == null || req.query.days === '') ? undefined : resolveDays(req.query.days)

  try {
    const remediation = await leadPolicyRemediationFor(asOf, span)
    res.json({
      ...remediation,
      requested: { as_of: asOf || null, days: span ?? null },
      narrative: narrateLeadPolicyRemediation(remediation, { audience: 'agency' }),
    })
  } catch (err) {
    console.error('[ai] GET lead-policy-governance-remediation error', err.message)
    res.status(500).json({ error: 'Failed to load lead policy governance remediation' })
  }
})

// ── POST /api/ai/brief-feedback ─────────────────────────────────────────────────
// intel-v8 layer 18 — the dashboard's FIRST outward-facing loop. Every layer above
// (brief-health → lead-policy → … → remediation) is inward self-governance; NONE asks
// the one question only the reader can answer: was the brief USEFUL? This records that
// — one 👍/👎 per client per morning — as a reversible upsert. The clientId comes ONLY
// from the token (resolveConsumerScope), never the body, so a caller can only ever vote
// on their OWN brief; an agency token (no client_id) is refused. ?as_of / { as_of }
// selects the rated morning (absent → today, UTC). signal must be helpful|not_helpful.
// Returns the { as_of, signal } that now stands, so the client UI reflects the vote back
// — and NOTHING aggregate (no rate, no other client) ever crosses this client egress.
router.post('/brief-feedback', async (req, res) => {
  const signal = req.body?.signal
  if (signal !== 'helpful' && signal !== 'not_helpful') {
    return res.status(400).json({ error: 'signal must be helpful | not_helpful' })
  }
  const { clientId, error: scopeErr, status } = resolveConsumerScope(req)
  if (scopeErr) return res.status(status).json({ error: scopeErr })
  const { asOf, error } = resolveAsOf(req.query.as_of ?? req.body?.as_of)
  if (error) return res.status(400).json({ error })

  try {
    const vote = await recordBriefFeedback({ clientId, asOf, signal })
    res.json(vote)
  } catch (err) {
    console.error('[ai] POST brief-feedback error', err.message)
    res.status(500).json({ error: 'Failed to record brief feedback' })
  }
})

// ── GET /api/ai/brief-feedback ──────────────────────────────────────────────────
// The consumer reads back THEIR OWN vote for a morning so the 👍/👎 control can paint
// its current state. Token-scoped exactly like the write (resolveConsumerScope): a
// client only ever sees their own row. ?as_of selects the morning (absent → today, UTC).
// signal is null when the client has not voted that day. No aggregate ever appears here.
router.get('/brief-feedback', async (req, res) => {
  const { clientId, error: scopeErr, status } = resolveConsumerScope(req)
  if (scopeErr) return res.status(status).json({ error: scopeErr })
  const { asOf, error } = resolveAsOf(req.query.as_of)
  if (error) return res.status(400).json({ error })

  try {
    const vote = await getClientBriefFeedback({ clientId, asOf })
    res.json(vote)
  } catch (err) {
    console.error('[ai] GET brief-feedback error', err.message)
    res.status(500).json({ error: 'Failed to load brief feedback' })
  }
})

// ── GET /api/ai/brief-engagement ────────────────────────────────────────────────
// The AGENCY aggregate that closes layer 18's loop: roll EVERY client's 👍/👎 over a
// trailing window into a portfolio helpful_rate + label + trend, a per-client board
// (worst reception first), and a watch list of clients whose brief is landing poorly or
// fading — the consumer-reception early-warning the agency learns from. AGENCY-ONLY by
// construction: it names per-client reception no client may see, so it shares the
// portfolio 403 gate (resolvePortfolioScope) and the narration is agency-voiced (the
// pure narrator returns '' for the client audience unconditionally). ?days=N sizes the
// window (default 90, clamped 1..365); ?as_of anchors its end (default today, UTC). The
// portfolio top-level IS the grade shape, so narrateBriefEngagement reads off it directly.
router.get('/brief-engagement', async (req, res) => {
  const scope = resolvePortfolioScope(req)
  if (scope.error) return res.status(scope.status).json({ error: scope.error })
  const { asOf, error } = resolveAsOf(req.query.as_of)
  if (error) return res.status(400).json({ error })
  const days = resolveDays(req.query.days)

  try {
    const engagement = await getPortfolioEngagement({ asOf, days })
    // intel-v9 layer 19b: the supporting-cast breadth this same grade EARNS for tomorrow's
    // portfolio brief — derived in-process (deriveBriefEmphasis is pure, no extra round-trip)
    // so the agency sees the loop close in one payload: reception in → brief emphasis out.
    // Agency-only by inheritance — the whole route is resolvePortfolioScope-gated (403 for
    // client tokens) and narrateBriefEmphasis returns '' for the client audience regardless.
    const emphasis = deriveBriefEmphasis(engagement)
    res.json({
      ...engagement,
      requested: { as_of: asOf || null, days },
      narrative: narrateBriefEngagement(engagement, { audience: 'agency' }),
      emphasis,
      emphasis_narrative: narrateBriefEmphasis(emphasis, { audience: 'agency' }),
    })
  } catch (err) {
    console.error('[ai] GET brief-engagement error', err.message)
    res.status(500).json({ error: 'Failed to load brief engagement' })
  }
})

// ── POST /api/ai/ask ──────────────────────────────────────────────────────────
// Body: { question: string, clientId?: string }. Returns the deterministic rows
// plus a grounded one-line answer, scoped to whatever the caller is allowed to
// see (resolveAskScope): a client token only ever sees its own data; an agency
// token sees the whole book, or one client when it passes clientId. runAsk tags
// failures with a .code we map to honest statuses:
//   NO_AI          → 503  (no ANTHROPIC_API_KEY configured)
//   EMPTY          → 400  (blank question)
//   UNPARSEABLE    → 422  (couldn't map the question onto the query schema)
//   PARSE_TRANSPORT→ 502  (the language model was unreachable)
const ASK_STATUS = { NO_AI: 503, EMPTY: 400, UNPARSEABLE: 422, PARSE_TRANSPORT: 502 }

router.post('/ask', async (req, res) => {
  const question = req.body?.question
  if (typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: 'question is required' })
  }

  try {
    const scope = await resolveAskScope(req)
    if (scope.error) return res.status(scope.status).json({ error: scope.error })

    const result = await runAsk(question, { scopeClientId: scope.scopeClientId })
    res.json(result)
  } catch (err) {
    const status = ASK_STATUS[err.code]
    if (status) {
      return res.status(status).json({ error: err.message, code: err.code })
    }
    console.error('[ai] POST ask error', err.message)
    res.status(500).json({ error: 'Failed to answer question' })
  }
})

// ── POST /api/ai/ask/explain ──────────────────────────────────────────────────
// Body: { spec: <the spec runAsk returned>, clientId?: string }. The grounded
// "why did it change?" click-through: given the SAME typed spec a prior /ask
// answer carried, decompose its period-over-period agency move into exact
// per-client contributions (lib/ask.runExplain → lib/contribution). No LLM, pure
// DB arithmetic, so no ANTHROPIC_API_KEY needed. Scoped by the SAME resolveAskScope
// boundary as /ask — a client token only ever explains its own (and runExplain
// returns null for a scoped caller, since a per-client view has no cross-client
// "who"). A spec that isn't decomposable (non-additive metric, already grouped, or
// no comparable prior window) → 422 NOT_EXPLAINABLE; the UI only offers the chip
// when runAsk flagged meta.explainable, so that 422 is the rare race, not the norm.
router.post('/ask/explain', async (req, res) => {
  const spec = req.body?.spec
  if (spec == null || typeof spec !== 'object' || Array.isArray(spec)) {
    return res.status(400).json({ error: 'spec is required' })
  }

  try {
    const scope = await resolveAskScope(req)
    if (scope.error) return res.status(scope.status).json({ error: scope.error })

    const result = await runExplain(spec, { scopeClientId: scope.scopeClientId })
    if (!result) {
      return res.status(422).json({ error: 'this question cannot be broken down by client', code: 'NOT_EXPLAINABLE' })
    }
    res.json(result)
  } catch (err) {
    const status = ASK_STATUS[err.code]
    if (status) {
      return res.status(status).json({ error: err.message, code: err.code })
    }
    console.error('[ai] POST ask/explain error', err.message)
    res.status(500).json({ error: 'Failed to explain change' })
  }
})

// ── GET /api/ai/ask/suggestions[?clientId=…] ──────────────────────────────────
// Dynamic opening chips for the Ask box: the biggest period-over-period movers
// for whatever the caller is allowed to see — the SAME resolveAskScope boundary
// as POST /ask (a client token only ever gets its own movers; an agency token
// gets the whole book, or one client via ?clientId). Pure DB aggregation, NO LLM,
// so it never needs ANTHROPIC_API_KEY. A soft/runtime fault degrades to an empty
// list (HTTP 200) so the box quietly falls back to its static suggestions instead
// of surfacing an error on first paint. The scope authz boundary (403/404) is
// still honoured — only runtime faults degrade.
router.get('/ask/suggestions', async (req, res) => {
  try {
    const scope = await resolveAskScope(req)
    if (scope.error) return res.status(scope.status).json({ error: scope.error })

    const { suggestions, window_label } = await runSuggestions({ scopeClientId: scope.scopeClientId })
    res.json({ suggestions, window_label })
  } catch (err) {
    console.error('[ai] GET ask/suggestions error', err.message)
    res.json({ suggestions: [], window_label: 'vs the prior week' })  // soft-degrade, never 5xx
  }
})

module.exports = router
// Exposed for unit tests — the route's hard client-scope boundary. Attaching it
// to the exported router leaves the express mount (router-as-middleware) intact.
module.exports.resolveAskScope = resolveAskScope
// Exposed for unit tests — the brief-health route's two pure guards: the lenient
// day-window clamp and the agency-only portfolio gate (a client token must never
// reach the narration machinery). Same attach-to-router idiom as above.
module.exports.resolveDays = resolveDays
module.exports.resolvePortfolioScope = resolvePortfolioScope
// Exposed for unit tests — the consumer-feedback token-scope guard (layer 18b): the
// vote's clientId is derived ONLY from the authenticated token, never a body param,
// and an agency token (no client_id) is refused. Same attach-to-router idiom as above.
module.exports.resolveConsumerScope = resolveConsumerScope
