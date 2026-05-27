import { useState, useEffect, useRef } from 'react'
import { api, USE_API } from '@/lib/api'

/**
 * Central data store hook.
 * Provides clients, per-client metrics, agency settings, and period selection.
 * All views (Dashboard, ExecView, ClientView, etc.) consume this via props or outlet context.
 */

// Aggregate metrics across all clients for "all clients" view
function aggregateAll(metricsCache, clients) {
  const aggStats = {}
  const aggPrev  = {}
  const trendMap = {}

  const SUM_FIELDS = [
    'ads_spend','lsa_spend','meta_spend','raw_leads','mql','sql_count',
    'closed_won','projected_revenue','ads_leads','lsa_calls','lsa_booked_jobs',
    'meta_leads','gbp_views','gbp_calls','gbp_searches','gbp_directions',
    'gbp_website_clicks','ga4_sessions','ga4_new_users','ga4_conversions',
  ]

  Object.values(metricsCache).forEach(data => {
    const s = data.stats    || {}
    const p = data.prevStats || {}
    SUM_FIELDS.forEach(f => {
      aggStats[f] = (aggStats[f] || 0) + (s[f] || 0)
      aggPrev[f]  = (aggPrev[f]  || 0) + (p[f] || 0)
    })
    ;(data.trend || []).forEach(w => {
      if (!trendMap[w.week]) trendMap[w.week] = { week: w.week, revenue: 0, leads: 0, jobs: 0, spend: 0 }
      trendMap[w.week].revenue += w.revenue || 0
      trendMap[w.week].leads   += w.leads   || 0
      trendMap[w.week].jobs    += w.jobs    || 0
      trendMap[w.week].spend   += w.spend   || 0
    })
  })

  // Compute derived totals (mirrors api/routes/metrics.js `derive`)
  function totals(r) {
    r.total_spend   = (r.ads_spend || 0) + (r.lsa_spend || 0) + (r.meta_spend || 0)
    r.total_revenue = r.projected_revenue || 0
    r.total_leads   = r.raw_leads || 0
    r.total_closed  = r.closed_won || 0
    r.total_mql     = r.mql || 0
    r.roas          = r.total_spend > 0 ? r.total_revenue / r.total_spend : 0
    r.close_rate    = r.total_leads > 0 ? (r.total_closed / r.total_leads) * 100 : 0
    r.cpl           = r.total_leads > 0 ? r.total_spend / r.total_leads : 0
    return r
  }

  return {
    stats:     totals(aggStats),
    prevStats: totals(aggPrev),
    trend:     Object.values(trendMap).sort((a, b) => a.week.localeCompare(b.week)),
    goal:      null,
  }
}

export function useStore() {
  const [clients, setClients]         = useState([])
  const [selectedClient, setSelected] = useState('all')
  const [agencySettings, setSettings] = useState({ agency_name: '10X Performance', accent_hex: '#e53935' })
  const [loading, setLoading]         = useState(true)
  const [metricsLoading, setMLoading] = useState(false)
  const [selectedPeriod, setPeriod]   = useState('last_4w')
  const [metricsCache, setCache]      = useState({})   // { [clientId]: { stats, prevStats, trend, goal } }
  const [clientSummary, setSummary]   = useState([])   // clients[] merged with their stats

  const clientsRef = useRef([])

  // ── Load clients + settings ───────────────────────────────────────────────
  async function loadClients() {
    setLoading(true)
    try {
      const cls = await api.clients()
      const list = Array.isArray(cls) ? cls : []
      clientsRef.current = list
      setClients(list)
    } catch (err) {
      console.error('[useStore] clients error', err.message)
    } finally {
      setLoading(false)
    }

    // Agency settings separate — failure must NOT block clients
    try {
      const settings = await api.getAgencySettings()
      if (settings) setSettings(settings)
    } catch {
      // use defaults — not critical
    }
  }

  // ── Load metrics for every client ─────────────────────────────────────────
  async function loadMetrics(clientList, period) {
    if (!clientList.length) return
    setMLoading(true)
    try {
      const results = await Promise.all(
        clientList.map(c =>
          api.getMetrics(c.id, period)
            .then(d => ({ clientId: c.id, ...d }))
            .catch(() => ({ clientId: c.id, stats: {}, prevStats: {}, trend: [], goal: null }))
        )
      )
      const cache = {}
      results.forEach(r => { cache[r.clientId] = r })
      setCache(cache)

      // Build summary: each client object enriched with its aggregate stats
      const summary = clientList.map(c => ({
        ...c,
        ...(cache[c.id]?.stats || {}),
      }))
      setSummary(summary)
    } catch (err) {
      console.error('[useStore] metrics error', err.message)
    } finally {
      setMLoading(false)
    }
  }

  useEffect(() => { loadClients() }, [])

  useEffect(() => {
    if (clients.length > 0) loadMetrics(clients, selectedPeriod)
  }, [clients, selectedPeriod])

  // ── Derived data for the selected client (or all) ─────────────────────────
  const selectedData = (!selectedClient || selectedClient === 'all')
    ? aggregateAll(metricsCache, clients)
    : (metricsCache[selectedClient] || { stats: {}, prevStats: {}, trend: [], goal: null })

  const stats      = selectedData.stats     || {}
  const prevStats  = selectedData.prevStats  || {}
  const weeklyTrend = selectedData.trend    || []
  const currentGoal = selectedData.goal     || null

  function setSelectedClient(id) { setSelected(id) }
  function setSelectedPeriod(p)  { setPeriod(p) }

  function refresh() { loadClients() }

  return {
    // Client list
    clients,
    selectedClient,
    setSelectedClient,
    clientSummary,
    refreshClients: refresh,

    // Metrics for selected client (or aggregate)
    stats,
    prevStats,
    weeklyTrend,
    currentGoal,

    // Period selector
    selectedPeriod,
    setSelectedPeriod,

    // Agency branding
    agencySettings,

    // Loading states
    loading,
    metricsLoading,
    refresh,
  }
}
