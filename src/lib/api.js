import { getToken, clearToken } from '@/lib/auth'

const BASE = import.meta.env.VITE_API_URL || ''

async function put(path, body) {
  const token = getToken()
  const res = await fetch(`${BASE}${path}`, {
    method:  'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
  if (res.status === 401) { clearToken(); if (window.location.pathname !== '/login') window.location.href = '/login'; throw new Error('Session expired') }
  if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `API ${path} → ${res.status}`) }
  return res.json()
}

async function get(path) {
  const token = getToken()
  const res = await fetch(`${BASE}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (res.status === 401) {
    clearToken()
    if (window.location.pathname !== '/login') window.location.href = '/login'
    throw new Error('Session expired')
  }
  if (!res.ok) throw new Error(`API ${path} → ${res.status}`)
  return res.json()
}

async function del(path) {
  const token = getToken()
  const res = await fetch(`${BASE}${path}`, {
    method:  'DELETE',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (res.status === 401) { clearToken(); if (window.location.pathname !== '/login') window.location.href = '/login'; throw new Error('Session expired') }
  if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `API ${path} → ${res.status}`) }
  return res.json()
}

export async function post(path, body) {
  const token = getToken()
  const res = await fetch(`${BASE}${path}`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
  if (res.status === 401) { clearToken(); if (window.location.pathname !== '/login') window.location.href = '/login'; throw new Error('Session expired') }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error || `API ${path} → ${res.status}`)
  }
  return res.json()
}

/**
 * Ask-your-data query. Unlike post(), this preserves the server's error `code`
 * and HTTP `status` on the thrown Error so the UI can tell apart the honest
 * failure modes of POST /api/ai/ask:
 *   NO_AI (503) → key not configured · UNPARSEABLE (422) → couldn't map the
 *   question · PARSE_TRANSPORT (502) → model unreachable · else → generic.
 *
 * `clientId` (optional) narrows the answer to one client. It is only honoured for
 * an agency token; for a client token the server hard-pins the scope to that
 * user's own client and ignores this hint — so the client surface can pass its
 * own id freely without it ever being able to widen access.
 */
export async function ask(question, clientId) {
  const token = getToken()
  const res = await fetch(`${BASE}/api/ai/ask`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(clientId ? { question, clientId } : { question }),
  })
  if (res.status === 401) { clearToken(); if (window.location.pathname !== '/login') window.location.href = '/login'; throw new Error('Session expired') }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err  = new Error(data.error || `API /api/ai/ask → ${res.status}`)
    err.status = res.status
    err.code   = data.code || null
    throw err
  }
  return data
}

/**
 * Grounded "why did it change?" — the click-through on an answer that carried
 * `meta.explainable`. Hands the SAME typed `spec` the answer returned back to the
 * server, which decomposes that figure's period-over-period move into exact
 * per-client contributions (no LLM, pure arithmetic). Returns the breakdown
 * (lead client, ranked signed contributors, server-formatted display strings, a
 * grounded narration) — or, if the figure turned out flat on recompute, a graceful
 * `{ moved:false }` payload. Mirrors ask()'s error contract so the UI can tell the
 * honest failure modes apart; NOT_EXPLAINABLE (422) means this spec isn't
 * decomposable (the rare race where the affordance showed but the shape changed).
 *
 * `clientId` is honoured only for an agency token (same posture as ask()); a client
 * token is hard-pinned server-side, and a scoped caller gets null back anyway since
 * a single-client view has no cross-client "who" to attribute.
 */
export async function askExplain(spec, clientId) {
  const token = getToken()
  const res = await fetch(`${BASE}/api/ai/ask/explain`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(clientId ? { spec, clientId } : { spec }),
  })
  if (res.status === 401) { clearToken(); if (window.location.pathname !== '/login') window.location.href = '/login'; throw new Error('Session expired') }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err  = new Error(data.error || `API /api/ai/ask/explain → ${res.status}`)
    err.status = res.status
    err.code   = data.code || null
    throw err
  }
  return data
}

export const api = {
  clients:       ()               => get('/api/clients'),
  createClient:  (body)           => post('/api/clients', body),
  deleteClient:  (clientId)       => del(`/api/clients/${clientId}`),
  summary:       (client, period) => get(`/api/metrics/summary?client=${client}&period=${period}`),
  weekly:        (client, period) => get(`/api/metrics/weekly?client=${client}&period=${period}`),
  clientMetrics: (period)         => get(`/api/metrics/clients?period=${period}`),
  monthly:       (qs)             => get(`/api/metrics/monthly?${qs}`),
  // Agency settings (white-label)
  getAgencySettings: ()     => get('/api/agency/settings'),
  saveAgencySettings: body  => put('/api/agency/settings', body),
  // Goals
  getGoal:       (clientId, month) => get(`/api/goals/${clientId}${month ? `?month=${month}` : ''}`),
  saveGoal:      (clientId, body)  => put(`/api/goals/${clientId}`, body),
  // Weekly updates
  getUpdates:    (clientId, weeks) => get(`/api/updates/${clientId}?weeks=${weeks || 4}`),
  saveUpdate:    (clientId, body)  => put(`/api/updates/${clientId}`, body),
  // Shareable report links
  createShare:   (clientId, body)  => post(`/api/shares/${clientId}`, body),
  listShares:    (clientId)        => get(`/api/shares/${clientId}`),
  revokeShare:   (token)           => del(`/api/shares/revoke/${token}`),
  getShareData:  (token)           => get(`/api/share/${token}`),
  // Campaigns
  getCampaigns:    (clientId, period) => get(`/api/campaigns/${clientId}?period=${period || 'last_4w'}`),
  addCampaign:     (clientId, body)   => post(`/api/campaigns/${clientId}`, body),
  updateCampaign:  (clientId, extId, body) => put(`/api/campaigns/${clientId}/${extId}`, body),
  deleteCampaign:  (clientId, extId)  => del(`/api/campaigns/${clientId}/${extId}`),
  // Email digest prefs + manual test send
  getEmailPrefs:    (clientId)       => get(`/api/clients/${clientId}/email`),
  saveEmailPrefs:   (clientId, body) => put(`/api/clients/${clientId}/email`, body),
  sendTestDigest:   (clientId, to)   => post(`/api/clients/${clientId}/digest/send`, to ? { to } : {}),
  // Connections — list active connections for a client
  listConnections:  (clientId)           => get(`/api/connections/${clientId}`),
  saveConnection:   (clientId, ch, creds) => put(`/api/connections/${clientId}/${ch}`, { credentials: creds }),
  testConnection:   (clientId, ch)       => post(`/api/connections/${clientId}/${ch}/test`, {}),
  deleteConnection: (clientId, ch)       => del(`/api/connections/${clientId}/${ch}`),
  // Agency settings
  agencySettings:     ()     => get('/api/agency'),
  saveAgencySettings: (body) => put('/api/agency', body),
  // Agency-wide anomalies (used by AnomalyStrip)
  getAnomalies: (period) => get(`/api/metrics?period=${period || 'last_4w'}`),
  // Per-client metrics
  getMetrics:    (clientId, period) => get(`/api/metrics/${clientId}?period=${period || 'last_4w'}`),
  weeklyTrend:   (clientId, weeks)  => get(`/api/metrics/${clientId}/weekly?weeks=${weeks || 8}`),
  // Manual weekly metric entry (reports)
  saveReport:    (clientId, body) => post(`/api/reports/${clientId}`, body),
  getLatestReport: (clientId)     => get(`/api/reports/${clientId}/latest`),
  // Ask-your-data (Sprint 2): natural-language portfolio questions
  ask,
  // askExplain (intel-v6 (5)): the grounded "why did it change?" click-through. Pass
  // the SAME spec a prior ask() answer carried (result.spec) when its meta.explainable
  // was true; the server splits that figure's period-over-period move into exact
  // per-client contributions. Same scope rules as ask(). Throws with .code/.status on
  // the honest failure modes (NOT_EXPLAINABLE 422 = this spec isn't decomposable).
  askExplain,
  // askSuggestions (intel-v6): dynamic opening chips for the Ask box — the biggest
  // period-over-period movers for whatever the caller is allowed to see, each a
  // click-to-run question. Same scope rules as ask(): a client token only ever gets
  // its own movers; an agency token gets the whole book, or one client via clientId.
  // Returns { suggestions, window_label }; the route soft-degrades to an empty list
  // on a runtime fault, so the box quietly falls back to its static prompts.
  askSuggestions: (clientId) => get(`/api/ai/ask/suggestions${clientId ? `?clientId=${encodeURIComponent(clientId)}` : ''}`),
  // Weekly AI recap (intel-v5): the grounded, verifier-checked narration of a client's most
  // recently completed week — now carrying the intelligence-posture digest folded into its
  // evidence pack (lib/intelDigest.js). getRecap() READS it, generating on the first miss for
  // a (client, week) then serving the cached row cheaply thereafter (the same row the Monday
  // email already pre-warmed); regenerateRecap() forces a fresh narration + re-verify — the
  // in-app "Regenerate" button. `week` is an optional Monday 'YYYY-MM-DD'; omit for the most
  // recent completed week. The route returns the recap row DIRECTLY (recap_text / grounded /
  // model / week_start / evidence_pack), not wrapped in an envelope.
  getRecap:        (clientId, week) => get(`/api/ai/recap/${clientId}${week ? `?week=${week}` : ''}`),
  regenerateRecap: (clientId, week) => post(`/api/ai/recap/${clientId}`, week ? { week } : {}),
  // AI Morning Brief (intel-v7 9): the DAILY analog of the weekly recap — a grounded,
  // verifier-checked narration of ONE day's pulse, generated-on-miss then served cheaply
  // from the cached row (one LLM call per scope per day). Two audiences, one table:
  //   getPortfolioBrief()  → the agency book's whole-pulse brief (AGENCY-ONLY; the prose
  //       names other clients, so a client token is refused). regeneratePortfolioBrief()
  //       force-renarrates — the agency "Regenerate" button.
  //   getClientBrief(id)   → one client's own morning brief (own numbers only).
  //       regenerateClientBrief(id) force-renarrates — the client card's "Regenerate".
  // `asOf` is an optional 'YYYY-MM-DD'; omit for today (UTC). Each returns the brief row
  // DIRECTLY ({ brief_text, grounded, model, as_of, audience, pack }), like getRecap().
  getPortfolioBrief:        (asOf)       => get(`/api/ai/brief${asOf ? `?as_of=${asOf}` : ''}`),
  regeneratePortfolioBrief: (asOf)       => post('/api/ai/brief', asOf ? { as_of: asOf } : {}),
  getClientBrief:           (clientId, asOf) => get(`/api/ai/brief/${clientId}${asOf ? `?as_of=${asOf}` : ''}`),
  regenerateClientBrief:    (clientId, asOf) => post(`/api/ai/brief/${clientId}`, asOf ? { as_of: asOf } : {}),
  // getBriefHealth (intel-v7 10): the AI's narration self-grade — over the recent brief
  // history, how many of the NARRATABLE morning briefs the model actually WROTE versus
  // silently fell back to the safe template (read off `model`, never `grounded`), plus the
  // always-on grounded invariant surfaced separately. AGENCY-ONLY: it names the internal
  // machinery (model ids, fallback streaks) a client never sees, so the route shares the
  // portfolio-brief 403 posture — a client token is refused. `days` tunes the look-back
  // (default 30, clamped 1..365 server-side). Returns the full summarizeBriefQuality shape
  // ({ total, window, grounded_rate, all_grounded, overall, by_audience }) plus an echoed
  // `requested` window and one agency-voiced `narrative` sentence off the overall bucket.
  getBriefHealth:           (days)       => get(`/api/ai/brief-health${days ? `?days=${days}` : ''}`),
  // brief-IMPACT (intel-v7 12): the editorial-PRECISION read — orthogonal to brief-health's
  // mechanics/reliability. Replays the self-tuning day-pulse over the mornings that FOLLOWED
  // each shipped lead and grades it earned/fair/overcalled (did the thing we put at the TOP of
  // the brief actually hold up, or are we overcalling?). Names a tighten-lead-selection action
  // and exposes by_lane/by_audience grading no client should read, so it shares the same 403
  // posture — a client token is refused. `days` tunes the look-back (default 30, clamped
  // 1..365). Returns the full summarizeBriefImpact shape ({ status, label, hit_rate, sample,
  // judged, hits, misses, unknown, by_lane, by_audience }) plus echoed `requested` + one
  // agency-voiced `narrative` sentence.
  getBriefImpact:           (days)       => get(`/api/ai/brief-impact${days ? `?days=${days}` : ''}`),
  // CONSUMER ENGAGEMENT (intel-v8 18, agency-only, 403 for client tokens). brief-impact and
  // brief-health grade the brief from the INSIDE (did our editorial judgment hold? does the
  // narrator still write?); this is the FIRST outward loop — it reads the one signal only the
  // human can give, the 👍/👎 they left on their own morning brief. Rolls every client's votes
  // over a trailing window into a portfolio helpful_rate + a per-client board (worst reception
  // first) + a `watch` list of clients whose brief is landing poorly OR whose reception is
  // declining — a consumer-satisfaction early warning the agency owns and the client never sees.
  // The aggregate is strictly agency-only: this endpoint 403s a client token, and the client
  // surface only ever reflects a client's OWN vote back, never any rollup. Returns the
  // getPortfolioEngagement shape ({ status, helpful_rate, label, trend, recent_rate, older_rate,
  // counts, requested_min_votes, by_client:[{client_id,name,...grade}], watch, clients_graded,
  // clients_total }) plus echoed `requested` + one agency-voiced `narrative` (empty until graded).
  // `days` sizes the reception window (default 90 — reception moves slowly; clamp 1..365).
  getBriefEngagement:       (days)       => get(`/api/ai/brief-engagement${days ? `?days=${days}` : ''}`),
  // EMPHASIS EFFICACY (intel-v9 20, agency-only, 403 for client tokens). getBriefEngagement grades
  // reception and earns tomorrow's supporting-cast cap; THIS grades whether that earning actually
  // WORKED — did widening SUSTAIN reception and did tightening RECOVER it, measured against the
  // control of mornings the brief held steady — and emits a bounded, shrunk step-scale a future
  // controller feeds back to make the cap-tuner self-improving. Pure meta-telemetry over the
  // persisted brief history (consecutive mornings pair a decision with its follow-on reception for
  // free); strictly agency-only — this endpoint 403s a client token and narrateEmphasisEfficacy is
  // '' for the client audience. Returns the summarizeEmphasisEfficacy shape ({ status, control_rate,
  // control_n, prior, directions:{widen,tighten}, recommendation:{widen_step_scale, tighten_step_scale,
  // verdict, reason}, n }) plus echoed `requested` + one agency-voiced `narrative` (empty until
  // graded). `days` sizes the trajectory window (default 90 — efficacy grades a history of decisions,
  // not one morning's snapshot; clamp 1..365).
  getBriefEmphasisEfficacy: (days)       => get(`/api/ai/brief-emphasis-efficacy${days ? `?days=${days}` : ''}`),
  // THE CONTROLLER — closes the second-order loop (intel-v9 21, agency-only, 403 for client tokens).
  // getBriefEmphasisEfficacy MEASURES whether layer 19's cap flexes worked and emits a bounded
  // step-scale per direction; THIS feeds that learned scale back into the MAGNITUDE of 19's next
  // flex — endorse (lean_in, step +1) when a direction is paying off, temper (ease_off, step −1)
  // when it isn't, hold (identity) when neutral or unmeasured. So the system doesn't just react to
  // reception once and grade it forever — the grade re-shapes the next reaction. reception → flex
  // (19) → efficacy (20) → scaled flex (21). Honest by abstention: no flex to scale, or no measured
  // efficacy → identity pass-through of 19's decision (control_move 'none'). Strictly agency-only —
  // 403s a client token, narrateEmphasisControl is '' for the client audience, and none of the
  // control vocabulary crosses the client egress (proven in 21d). Returns the applyEmphasisControl
  // superset ({ status, also_cap, delta, direction, controlled, control_move, control_reason,
  // step_scale, base_step, controlled_step, base_cap, min_cap, max_cap, emphasis_also_cap,
  // helpful_rate, label, trend, n, emphasis_reason }) plus echoed `requested` + one agency-voiced
  // `narrative` (empty unless the controller actually moved the cap). `days` sizes the efficacy
  // window the controller reads (default 90; clamp 1..365).
  getBriefEmphasisControl:  (days)       => get(`/api/ai/brief-emphasis-control${days ? `?days=${days}` : ''}`),
  // WATCH THE CONTROLLER (intel-v9 22, agency-only, 403 for client tokens — the OUTWARD twin of
  // getLeadPolicyHealth). getBriefEmphasisControl is the layer-21 controller that scales the
  // MAGNITUDE of layer 19's cap flex from layer 20's efficacy grade; THIS watches that controller
  // for instability across a HISTORY of recent mornings — it flags HUNTING (the controller reverses
  // itself lean_in<->ease_off day after day, never converging) and SATURATING (its move pins to a
  // bound run after run). Carries one self-healing recommended_action ('damp' on hunting — the same
  // signal the morning brief consults before it applies the controlled flex; on damp the brief eases
  // the magnitude back to layer 19's un-modulated cap for that morning). Returns the
  // assessEmphasisControlHealth shape ({ status, recommended_action, as_of, window_used, history_len,
  // bounds, control, verdict_reason }) plus echoed `requested` + one agency-voiced `narrative`
  // (empty unless the controller is genuinely unstable, saturating, or proven-stable). `days` sizes
  // the history window (mornings to assess, clamp 2..14); absent → the monitor's own default window.
  getBriefEmphasisControlHealth: (days)  => get(`/api/ai/brief-emphasis-control-health${days ? `?days=${days}` : ''}`),
  // ADAPTIVE GAIN (intel-v9 23, agency-only — the CHRONIC schedule over the acute governor above).
  // getBriefEmphasisControlHealth watches the controller one window at a time and benches it the
  // moment it hunts; THIS reads a HISTORY of those governor verdicts and, when hunting RECURS across
  // mornings, narrows how far the controller is allowed to swing at all (reach < max_reach), then
  // restores the full range once the loop proves it has converged. Returns the
  // tuneEmphasisControlAuthority shape ({ status, recommended_action, reach, max_reach, authority,
  // effective_bounds, bounds, window_used, history_len, as_of, governor, reason }) plus echoed
  // `requested` + one agency-voiced `narrative` (empty unless the range was just narrowed or handed
  // back). Computed from the governor's read of the RAW controller (never the narrowed one), so the
  // breaker keeps grading an un-tuned loop — the only trace a narrow leaves on a brief is a smaller
  // breadth cap (a layer-19 projection); this verdict rides NO serialized pack. `days` sizes the
  // governor history (mornings to schedule over, clamp 2..14); absent → the scheduler's own default.
  getBriefEmphasisControlTuning: (days)  => get(`/api/ai/brief-emphasis-control-tuning${days ? `?days=${days}` : ''}`),
  // CONSUMER OWN-VOTE (intel-v8 18d, client-scoped — the OUTWARD half of the engagement loop).
  // getBriefEngagement above reads the whole-book aggregate (agency-only, 403 for a client token);
  // THESE two are all a client ever touches — their own 👍/👎 on their own morning brief, one day.
  // clientId is NEVER a param: the server derives it from the authenticated token
  // (resolveConsumerScope), so a client can only ever write/read their OWN row, and the response is
  // strictly { as_of, signal } (signal: 'helpful' | 'not_helpful' | null) — never a rate, a
  // neighbour, or any rollup. submitBriefFeedback upserts (re-voting overwrites in place, so 👍→👎
  // is one reversible call); getBriefFeedback reads the vote that now stands (signal null = not yet
  // voted). `asOf` (optional 'YYYY-MM-DD') targets one morning; absent → today (server-side, UTC).
  submitBriefFeedback:      (signal, asOf) => post('/api/ai/brief-feedback', asOf ? { signal, as_of: asOf } : { signal }),
  getBriefFeedback:         (asOf)         => get(`/api/ai/brief-feedback${asOf ? `?as_of=${asOf}` : ''}`),
  // The TUNE half of the lead loop (agency-only, 403 for client tokens). brief-impact MEASURES
  // whether shipped leads held up; lead-policy turns that grade into the bounded per-lane policy
  // the morning brief applies — each triage lane's hit_rate → a weight in [0.8, 1.2], act_now
  // floored at >=1.0 so a learned-noisy emergency lane is never down-weighted. Returns the full
  // deriveLeadPolicy shape ({ status, neutral_rate, bounds, safety_floor_lanes, lanes, promoted,
  // demoted, floored, adjusted_count }) plus echoed `requested` + one agency-voiced `narrative`.
  getLeadPolicy:            (days)       => get(`/api/ai/lead-policy${days ? `?days=${days}` : ''}`),
  // WATCH THE WATCHER (intel-v7 14, agency-only, 403 for client tokens). lead-policy TUNES the
  // lead loop; lead-policy-health judges whether that loop is still trustworthy or chasing its
  // own tail — it reads a HISTORY of recent daily policies and flags oscillation (a lane flips
  // promote<->demote morning after morning), saturation (a weight pinned at the ±20% bound), and
  // floor-masking (the act_now safety floor catching the same lane run after run). Carries one
  // self-healing recommended_action ('revert_to_neutral' on oscillation — the same signal the
  // morning brief consults before it applies the policy). Returns the assessLeadPolicyHealth shape
  // ({ status, recommended_action, as_of, window_used, history_len, bounds, lanes, counts,
  // verdict_reason }) plus echoed `requested` + one agency-voiced `narrative`. `days` sizes the
  // history window (mornings to assess); absent → the monitor's own default window.
  getLeadPolicyHealth:      (days)       => get(`/api/ai/lead-policy-health${days ? `?days=${days}` : ''}`),
  // THE GOVERNOR (intel-v7 15, agency-only, 403 for client tokens). lead-policy-health DIAGNOSES
  // the tuning loop; lead-policy-governance is what the loop DID about it — the self-governing
  // controller that consumes the stability verdict and autonomously applies the safe per-lane
  // corrective to the policy (idempotent, reversible via the pre-governance snapshot, verify-after,
  // bounded blast radius, no human in the path). Neutralises ONLY a thrashing lane and keeps every
  // honestly-earned lane live, so a learned order can still apply where layer 14's blunt all-or-
  // nothing revert would have thrown the whole policy out; saturation and floor-masking it logs for
  // a human rather than auto-widening the band. Returns the governLeadPolicy shape ({ status:
  // 'corrected'|'advised'|'clean'|'abstained', verdict_status, source_status, governed,
  // interventions (action neutralize|hold_at_bound|respect_floor, from_weight→to_weight), snapshot,
  // counts }) plus echoed `requested` + one agency-voiced `narrative` spoken only when a weight was
  // actually reset. `days` sizes the history window the verdict is read over. Never client-facing.
  getLeadPolicyGovernance:  (days)       => get(`/api/ai/lead-policy-governance${days ? `?days=${days}` : ''}`),
  // THE AUDITOR (intel-v7 16, agency-only, 403 for client tokens). The governor (15) ACTS every
  // morning — it applies the safe corrective and moves on. But it never grades its own homework:
  // a lane the learner keeps re-oscillating and the governor keeps neutralising looks "handled"
  // each single morning while the underlying cause never resolves. This reads GET
  // /api/ai/lead-policy-governance-audit — the LEARN/ADJUST half that watches the governor's OWN
  // track record across mornings, classifies each lane's intervention outcome (recurring keeps
  // needing the same reset / resolved the reset stuck / intermittent on-and-off / one_off corrected
  // once), and when the safe corrective isn't STICKING recommends escalating that lane to a human
  // instead of letting the loop churn forever. The governor keeps holding the line meanwhile —
  // the auditor only recommends, never acts. Returns the auditLeadPolicyGovernance shape ({ status:
  // 'churning'|'effective'|'quiet'|'abstained', recommendation: { action: 'escalate'|'none', lanes },
  // counts: { recurring, resolved, intermittent, one_off, corrected_mornings, advisory_mornings,
  // quiet_mornings }, lanes, window_used, history_len }) plus echoed `requested` + one agency-voiced
  // `narrative` spoken only when a lane is churning. `days` sizes the audit window. Never client-facing.
  getLeadPolicyGovernanceAudit: (days)   => get(`/api/ai/lead-policy-governance-audit${days ? `?days=${days}` : ''}`),
  // The ADJUST rung that closes the lead-policy loop. When the auditor escalates a recurring
  // neutralize correction, the remediator proposes ONE concrete bounded reversible structural fix
  // per churning lane (widen dead-band → tighten bounds → pin neutral, deepening by what's already
  // been tried), staged for a single agency click; safety-floored lanes (act_now) are never touched.
  // Returns the proposeLeadPolicyRemediation shape ({ status: 'remediation_proposed'|'steady'|
  // 'abstained', proposals: [{ lane, remedy, severity, from, to, reversible, rationale }],
  // abstained_lanes, lanes_considered, as_of, remediation_reason }) plus echoed `requested` + one
  // agency-voiced `narrative` spoken only when a fix is staged. `days` sizes the audit window the
  // proposal rests on. Never client-facing.
  getLeadPolicyGovernanceRemediation: (days) => get(`/api/ai/lead-policy-governance-remediation${days ? `?days=${days}` : ''}`),
  // Explore (Sprint 2): semantic query over the atomic fact grain.
  // querySchema() drives the control vocabulary; query(spec) runs it.
  querySchema:   ()     => get('/api/query/schema'),
  query:         (spec) => post('/api/query', spec),
  // Intelligence (intel-v2): autonomous insight feed + lifecycle.
  // getInsights() → portfolio roll-up; getClientInsights() → one client's feed;
  // ack/resolve record a human decision the engine won't overwrite; runInsights()
  // forces a fresh pass (one client, or the whole portfolio when clientId is null).
  // getPortfolioHealth() → triage roster: every client as one 0–100 health score,
  // ranked worst-first ("where do I look first?"). The synthesis grain on top of
  // the per-finding feed; getClientInsights() now also returns that client's health.
  getInsights:        ()         => get('/api/insights'),
  getPortfolioHealth: ()         => get('/api/insights/health'),
  // getBenchmarks() → portfolio PEER benchmark: each KPI's cross-client distribution
  // + every client's direction-aware percentile/quartile over a trailing window
  // (agency view; carries peer identities). A client's OWN anonymous standing rides
  // along inside getClientInsights() (.benchmark), never exposing peers.
  getBenchmarks:      (weeks)    => get(`/api/insights/benchmarks${weeks ? `?weeks=${weeks}` : ''}`),
  // getRecoveries() → portfolio "what we fixed" win stream: every client's recently
  // RECOVERED findings (metric back to baseline / channel reconnected), newest fix
  // first, each tagged with client_name. The positive counterpart to getInsights().
  // A client's OWN recent wins ride along inside getClientInsights() (.recoveries).
  getRecoveries:      (days)     => get(`/api/insights/recoveries${days ? `?days=${days}` : ''}`),
  // getSystemic() → portfolio SYSTEMIC scan: cross-client common-cause clusters (the same
  // adverse channel/metric/direction independently hitting ≥ minClients clients), collapsed
  // into one signal apiece — "leads down across 14 clients, 38% of the book". Answers "is
  // this us, or the platform?" AGENCY-ONLY: a signal names other clients + the book-wide
  // share, so this never rides getClientInsights() — it's the agency Intelligence view only.
  getSystemic:        (opts = {}) => {
    const qs = new URLSearchParams()
    if (opts.minClients != null) qs.set('minClients', opts.minClients)
    if (opts.minShare   != null) qs.set('minShare',   opts.minShare)
    const q = qs.toString()
    return get(`/api/insights/systemic${q ? `?${q}` : ''}`)
  },
  // getTrajectory() → portfolio EARLY-WARNING roster: the PREDICTIVE grain. Reads the
  // per-sweep health history forward and flags clients still in a safe band but, by the
  // slope of their own scores, projected to slide THROUGH a floor within ?horizon sweeps —
  // "will churn unless you act this week," not "churned." AGENCY-ONLY: the roster names
  // other clients, so (like getSystemic) it never rides getClientInsights().
  getTrajectory:      (opts = {}) => {
    const qs = new URLSearchParams()
    if (opts.horizon != null) qs.set('horizon', opts.horizon)
    const q = qs.toString()
    return get(`/api/insights/trajectory${q ? `?${q}` : ''}`)
  },
  // getPacing() → portfolio GOAL-PACING roster: month-to-date actual vs. each client's human-set
  // monthly GOAL by linear run-rate — every client who, at today's pace, will MISS a goal, worst
  // first ("on pace for 60% of leads goal, must run 2× to still hit it"). The save before the month
  // closes, not the post-mortem after. AGENCY-ONLY: the roster names other clients, so (like
  // getSystemic/getTrajectory) it never rides getClientInsights() — a client's OWN pace rides
  // inside getClientInsights() (.pacing), own numbers only. No params (current month, clock = now).
  getPacing:          ()         => get('/api/insights/pacing'),
  // getPulse() → portfolio DAILY-PULSE roster: the INTRA-WEEK grain. The weekly engine is blind
  // between Mondays; this watches each client's trailing-7-day LEVEL on the ATOMIC DAILY facts and
  // flags every client × flow metric whose trailing week has slid out of that client's OWN recent
  // band RIGHT NOW — a Tuesday collapse (or a runaway spend spike) surfaced days before the Monday
  // recap, worst first. AGENCY-ONLY: a row names another client, so (like getSystemic/getTrajectory/
  // getPacing) it never rides getClientInsights() — a client's OWN pulse rides inside
  // getClientInsights() (.pulse), own numbers only. No params (trailing week, clock = now).
  getPulse:           ()         => get('/api/insights/pulse'),
  // getEfficacy() → portfolio EFFICACY LEDGER: the self-improving grain — does the recommended PLAY
  // actually fix the problem? Per play archetype (kind::metric), the measured recovery rate (shrunk
  // toward the pooled base rate, ranked by a Wilson lower bound so a deep 9/10 beats a lucky 1/1) plus
  // the median days-to-recovery — how the system learns which of its OWN advice earns its place. Pooled
  // + ANONYMOUS (a rate names no client). Optional { priorWeight } (shrink strength, 0..100; default 6).
  getEfficacy:        (opts = {}) => {
    const qs = new URLSearchParams()
    if (opts.priorWeight != null) qs.set('priorWeight', String(opts.priorWeight))
    const q = qs.toString()
    return get(`/api/insights/efficacy${q ? `?${q}` : ''}`)
  },
  getClientInsights:  (clientId) => get(`/api/insights/${clientId}`),
  ackInsight:         (id)       => post(`/api/insights/${id}/ack`, {}),
  resolveInsight:     (id)       => post(`/api/insights/${id}/resolve`, {}),
  runInsights:        (clientId) => post(clientId ? `/api/insights/${clientId}/run` : '/api/insights/run', {}),
}

export function subscribeRealtime(onRefresh) {
  const token = getToken()
  const url   = `${BASE}/api/realtime${token ? `?token=${token}` : ''}`
  const es    = new EventSource(url)
  es.addEventListener('refresh', onRefresh)
  es.onerror = () => {}
  return () => es.close()
}

export const USE_API = Boolean(import.meta.env.VITE_API_URL)
