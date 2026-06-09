import { useState, useEffect } from 'react'
import {
  Target, ChevronLeft, ChevronRight, Check, AlertCircle,
} from 'lucide-react'
import { api, USE_API } from '@/lib/api'
import { useOutletContext } from 'react-router-dom'

// ── Helpers ────────────────────────────────────────────────────────────────
function currentMonth() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function monthAdd(ym, n) {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(y, m - 1 + n, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number)
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}

// ── Mock preset goals (dev/demo mode) ─────────────────────────────────────
const MOCK_PRESETS = [
  { revenue: 50000,  leads: 35, jobs: 8 },
  { revenue: 120000, leads: 50, jobs: 12 },
  { revenue: 75000,  leads: 40, jobs: 10 },
]

// ── Input ──────────────────────────────────────────────────────────────────
function GoalInput({ prefix, value, placeholder, onChange, onEnter, disabled }) {
  return (
    <div className="relative">
      {prefix && (
        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-slate-500 pointer-events-none select-none">
          {prefix}
        </span>
      )}
      <input
        type="number"
        min="0"
        placeholder={placeholder ?? '—'}
        value={value ?? ''}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && onEnter?.()}
        disabled={disabled}
        className={`w-full py-1.5 rounded-lg bg-white/5 border border-white/10 text-sm text-slate-200 placeholder-slate-600
          focus:outline-none focus:border-brand-500/50 disabled:opacity-40
          ${prefix ? 'pl-5 pr-2' : 'px-2.5'}`}
      />
    </div>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────
export default function Goals() {
  const ctx     = useOutletContext()
  const clients = ctx?.clients ?? []

  const [month,     setMonth]     = useState(currentMonth)
  const [goals,     setGoals]     = useState({})     // { [clientId]: { revenue, leads, jobs, dirty } }
  const [rowStatus, setRowStatus] = useState({})     // { [clientId]: 'idle'|'loading'|'saving'|'saved'|'error' }
  const [fetching,  setFetching]  = useState(false)

  // ── Load goals whenever month or clients change ────────────────────────
  useEffect(() => {
    if (!clients.length) return

    if (!USE_API) {
      // Seed mock data — first 3 clients get pre-filled targets
      const g = {}
      clients.forEach((c, i) => {
        const p = MOCK_PRESETS[i] || { revenue: '', leads: '', jobs: '' }
        g[c.id] = { revenue: p.revenue, leads: p.leads, jobs: p.jobs, dirty: false }
      })
      setGoals(g)
      setRowStatus({})
      return
    }

    setFetching(true)
    const loading = Object.fromEntries(clients.map(c => [c.id, 'loading']))
    setRowStatus(loading)

    Promise.allSettled(clients.map(c => api.getGoal(c.id, month)))
      .then(results => {
        const newGoals  = {}
        const newStatus = {}
        results.forEach((r, i) => {
          const id  = clients[i].id
          const row = r.status === 'fulfilled' ? r.value : null
          newGoals[id]  = {
            revenue: row?.revenue_target ?? '',
            leads:   row?.leads_target   ?? '',
            jobs:    row?.jobs_target    ?? '',
            dirty:   false,
          }
          newStatus[id] = 'idle'
        })
        setGoals(newGoals)
        setRowStatus(newStatus)
        setFetching(false)
      })
  }, [clients.length, month]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Field change ──────────────────────────────────────────────────────
  function setField(clientId, field, value) {
    setGoals(prev => ({
      ...prev,
      [clientId]: { ...prev[clientId], [field]: value, dirty: true },
    }))
    setRowStatus(prev => ({
      ...prev,
      [clientId]: prev[clientId] === 'saved' ? 'idle' : prev[clientId],
    }))
  }

  // ── Save a single row ─────────────────────────────────────────────────
  async function saveRow(clientId) {
    const g = goals[clientId]
    if (!g?.dirty) return
    if (!USE_API) {
      // Mock save — just mark saved
      setGoals(prev => ({ ...prev, [clientId]: { ...prev[clientId], dirty: false } }))
      setRowStatus(prev => ({ ...prev, [clientId]: 'saved' }))
      setTimeout(() => setRowStatus(prev => prev[clientId] === 'saved' ? { ...prev, [clientId]: 'idle' } : prev), 3000)
      return
    }

    setRowStatus(prev => ({ ...prev, [clientId]: 'saving' }))
    try {
      await api.saveGoal(clientId, {
        month,
        revenue_target: g.revenue !== '' ? Number(g.revenue) : null,
        leads_target:   g.leads   !== '' ? Number(g.leads)   : null,
        jobs_target:    g.jobs    !== '' ? Number(g.jobs)    : null,
      })
      setGoals(prev => ({ ...prev, [clientId]: { ...prev[clientId], dirty: false } }))
      setRowStatus(prev => ({ ...prev, [clientId]: 'saved' }))
      setTimeout(() => setRowStatus(prev => prev[clientId] === 'saved' ? { ...prev, [clientId]: 'idle' } : prev), 3000)
    } catch {
      setRowStatus(prev => ({ ...prev, [clientId]: 'error' }))
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-surface text-slate-100">
      {/* Header */}
      <div className="border-b border-white/5 px-6 py-5">
        <div className="max-w-3xl mx-auto flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-2.5 mb-1">
              <Target className="w-5 h-5 text-brand-400" />
              <h1 className="text-lg font-black text-white">Monthly Goals</h1>
            </div>
            <p className="text-sm text-slate-400">
              Set revenue, lead, and job targets — drives the goal progress bars on every client dashboard.
            </p>
          </div>

          {/* Month picker */}
          <div className="flex items-center gap-1 bg-surface-2 border border-white/10 rounded-xl p-1 shrink-0">
            <button
              onClick={() => setMonth(m => monthAdd(m, -1))}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
              title="Previous month"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="px-3 text-sm font-bold text-slate-200 min-w-[130px] text-center">
              {monthLabel(month)}
            </span>
            <button
              onClick={() => setMonth(m => monthAdd(m, 1))}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
              title="Next month"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-6 py-6 space-y-4">
        {/* Empty state */}
        {!clients.length && (
          <div className="border border-white/5 border-dashed rounded-2xl px-6 py-12 text-center">
            <Target className="w-8 h-8 text-brand-400/30 mx-auto mb-3" />
            <p className="text-sm font-bold text-slate-400">No clients found</p>
            <p className="text-xs text-slate-600 mt-1">Add clients first in the Clients tab</p>
          </div>
        )}

        {/* Goals table */}
        {!!clients.length && (
          <div className="rounded-2xl border border-white/5 overflow-hidden">
            {/* Column headers */}
            <div className="grid grid-cols-[1fr_150px_90px_90px_76px] gap-3 px-4 py-2.5 bg-white/[.02] border-b border-white/5">
              <p className="text-[10px] font-black uppercase tracking-wider text-slate-500">Client</p>
              <p className="text-[10px] font-black uppercase tracking-wider text-slate-500">Revenue</p>
              <p className="text-[10px] font-black uppercase tracking-wider text-slate-500">Leads</p>
              <p className="text-[10px] font-black uppercase tracking-wider text-slate-500">Jobs</p>
              <p className="text-[10px] font-black uppercase tracking-wider text-slate-500" />
            </div>

            {/* Rows */}
            <div className="divide-y divide-white/5">
              {clients.map(client => {
                const g   = goals[client.id] || {}
                const rs  = rowStatus[client.id] || 'idle'
                const isRowLoading = fetching || rs === 'loading'

                return (
                  <div
                    key={client.id}
                    className="grid grid-cols-[1fr_150px_90px_90px_76px] gap-3 items-center px-4 py-3"
                  >
                    {/* Name */}
                    <p className="text-sm font-semibold text-slate-200 truncate">{client.name}</p>

                    {/* Revenue */}
                    <GoalInput
                      prefix="$"
                      value={g.revenue}
                      placeholder="0"
                      onChange={v => setField(client.id, 'revenue', v)}
                      onEnter={() => saveRow(client.id)}
                      disabled={isRowLoading}
                    />

                    {/* Leads */}
                    <GoalInput
                      value={g.leads}
                      placeholder="0"
                      onChange={v => setField(client.id, 'leads', v)}
                      onEnter={() => saveRow(client.id)}
                      disabled={isRowLoading}
                    />

                    {/* Jobs */}
                    <GoalInput
                      value={g.jobs}
                      placeholder="0"
                      onChange={v => setField(client.id, 'jobs', v)}
                      onEnter={() => saveRow(client.id)}
                      disabled={isRowLoading}
                    />

                    {/* Status / action */}
                    <div className="flex justify-end">
                      {rs === 'saved' ? (
                        <span className="flex items-center gap-1 text-xs font-bold text-emerald-400">
                          <Check className="w-3 h-3" /> Saved
                        </span>
                      ) : rs === 'error' ? (
                        <span className="flex items-center gap-1 text-xs text-red-400">
                          <AlertCircle className="w-3 h-3" /> Error
                        </span>
                      ) : rs === 'saving' ? (
                        <span className="text-xs text-slate-400">Saving…</span>
                      ) : g.dirty ? (
                        <button
                          onClick={() => saveRow(client.id)}
                          className="px-3 py-1 bg-brand-500 hover:bg-brand-600 rounded-lg text-xs font-bold text-white transition-colors"
                        >
                          Save
                        </button>
                      ) : (
                        <span className="text-xs text-slate-700">—</span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Hint */}
        {!!clients.length && (
          <p className="text-xs text-slate-600 text-center">
            Press <kbd className="px-1 py-0.5 rounded bg-white/5 border border-white/10 text-slate-500 font-mono text-[10px]">Enter</kbd> in any field to save that row.
            Changes reflect on client dashboards immediately.
          </p>
        )}
      </div>
    </div>
  )
}
