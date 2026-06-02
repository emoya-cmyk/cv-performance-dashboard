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
