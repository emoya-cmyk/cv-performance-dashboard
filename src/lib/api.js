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
 */
export async function ask(question) {
  const token = getToken()
  const res = await fetch(`${BASE}/api/ai/ask`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ question }),
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
