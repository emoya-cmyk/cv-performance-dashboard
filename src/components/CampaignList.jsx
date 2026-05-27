import { useState, useEffect, useCallback } from 'react'
import { Plus, Trash2, BarChart2, ChevronDown } from 'lucide-react'
import { api, USE_API } from '@/lib/api'
import { fmt$$, fmtN } from '@/lib/utils'
import { isAgency } from '@/lib/auth'

const CHANNELS   = ['Google Ads', 'Meta Ads', 'LSA', 'Google GBP', 'Email', 'Other']
const PERIOD_OPTS = [
  { value: 'this_week', label: 'This Week'     },
  { value: 'last_4w',   label: 'Last 30 Days'  },
  { value: 'last_8w',   label: 'Last 60 Days'  },
]
const CH_STYLE = {
  'Google Ads': { bg: 'bg-blue-100',    text: 'text-blue-700',    dot: 'bg-blue-500'    },
  'Meta Ads':   { bg: 'bg-indigo-100',  text: 'text-indigo-700',  dot: 'bg-indigo-500'  },
  'LSA':        { bg: 'bg-cyan-100',    text: 'text-cyan-700',    dot: 'bg-cyan-500'    },
  'Google GBP': { bg: 'bg-emerald-100', text: 'text-emerald-700', dot: 'bg-emerald-500' },
  'Email':      { bg: 'bg-amber-100',   text: 'text-amber-700',   dot: 'bg-amber-500'   },
  'Other':      { bg: 'bg-slate-100',   text: 'text-slate-600',   dot: 'bg-slate-400'   },
}
function cs(ch) { return CH_STYLE[ch] || CH_STYLE['Other'] }

const MOCK = [
  { external_id: 'm1', name: 'Google Ads — Roofing Leads',    channel: 'Google Ads', status: 'active', total_spend: 3200, total_leads: 47, total_revenue: 18500, roas: 5.8 },
  { external_id: 'm2', name: 'Meta — Homeowner Retargeting',  channel: 'Meta Ads',   status: 'active', total_spend: 1100, total_leads: 22, total_revenue:  7200, roas: 6.5 },
  { external_id: 'm3', name: 'LSA — Emergency HVAC',          channel: 'LSA',        status: 'paused', total_spend:  500, total_leads:  8, total_revenue:  3100, roas: 6.2 },
]

// ── Inline "Add Campaign" form ─────────────────────────────────────────────────
function AddForm({ clientId, onAdded, onCancel }) {
  const [form, setForm] = useState({ name: '', channel: 'Google Ads', spend: '', leads: '', revenue: '' })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState('')

  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }))

  async function handleSubmit(e) {
    e.preventDefault()
    if (!form.name.trim()) { setError('Campaign name is required'); return }
    setSaving(true); setError('')
    try {
      await api.addCampaign(clientId, {
        name:    form.name.trim(),
        channel: form.channel,
        spend:   form.spend   !== '' ? Number(form.spend)   : 0,
        leads:   form.leads   !== '' ? Number(form.leads)   : 0,
        revenue: form.revenue !== '' ? Number(form.revenue) : 0,
      })
      onAdded()
    } catch (err) { setError(err.message) }
    finally { setSaving(false) }
  }

  const inputCls = 'w-full border border-slate-200 rounded-xl px-4 py-2.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent'

  return (
    <form onSubmit={handleSubmit} className="bg-slate-50 rounded-2xl border border-slate-100 p-4 mb-4">
      <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-3">
        Add Campaign — Current Week
      </p>
      <div className="space-y-2.5 mb-3">
        <input value={form.name} onChange={set('name')} placeholder="Campaign name (e.g. Google Ads — Roofing Q3)" className={inputCls} />
        <div className="grid grid-cols-2 gap-2.5">
          <select value={form.channel} onChange={set('channel')}
            className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-brand-500">
            {CHANNELS.map(c => <option key={c}>{c}</option>)}
          </select>
          <div className="relative">
            <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 text-sm font-bold">$</span>
            <input type="number" min="0" value={form.spend} onChange={set('spend')} placeholder="Spend"
              className="w-full border border-slate-200 rounded-xl pl-7 pr-3 py-2.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent" />
          </div>
          <input type="number" min="0" value={form.leads} onChange={set('leads')} placeholder="Leads"
            className={inputCls} />
          <div className="relative">
            <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 text-sm font-bold">$</span>
            <input type="number" min="0" value={form.revenue} onChange={set('revenue')} placeholder="Revenue"
              className="w-full border border-slate-200 rounded-xl pl-7 pr-3 py-2.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent" />
          </div>
        </div>
      </div>
      {error && <p className="text-xs text-rose-500 font-semibold mb-2">{error}</p>}
      <div className="flex gap-2">
        <button type="button" onClick={onCancel}
          className="flex-1 border border-slate-200 text-slate-600 text-xs font-bold py-2 rounded-xl hover:bg-white transition-colors">
          Cancel
        </button>
        <button type="submit" disabled={saving}
          className="flex-1 bg-brand-500 hover:bg-brand-600 text-white text-xs font-black py-2 rounded-xl transition-colors disabled:opacity-50">
          {saving ? 'Saving…' : 'Add Campaign →'}
        </button>
      </div>
    </form>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────
export default function CampaignList({ clientId }) {
  const [period,    setPeriod]    = useState('last_4w')
  const [campaigns, setCampaigns] = useState([])
  const [loading,   setLoading]   = useState(true)
  const [showAdd,   setShowAdd]   = useState(false)

  const canEdit = !USE_API || isAgency()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      if (!USE_API) { setCampaigns(MOCK); return }
      const data = await api.getCampaigns(clientId, period)
      setCampaigns(data || [])
    } catch { setCampaigns([]) }
    finally { setLoading(false) }
  }, [clientId, period])

  useEffect(() => { load() }, [load])

  async function handleDelete(extId) {
    if (!window.confirm('Archive this campaign? (soft-delete — status → ended)')) return
    try { await api.deleteCampaign(clientId, extId) } catch { /* swallow */ }
    load()
  }

  // Don't render at all while first loading
  if (loading && !campaigns.length) return null

  const active    = campaigns.filter(c => c.status !== 'ended')
  const totalSpend   = active.reduce((s, c) => s + (parseFloat(c.total_spend)   || 0), 0)
  const totalLeads   = active.reduce((s, c) => s + (parseInt(c.total_leads)     || 0), 0)
  const totalRevenue = active.reduce((s, c) => s + (parseFloat(c.total_revenue) || 0), 0)
  const overallRoas  = totalSpend > 0 ? totalRevenue / totalSpend : null

  const roasColor = r => r == null ? '' : r >= 3 ? 'text-emerald-600' : r >= 1.5 ? 'text-amber-600' : 'text-rose-500'

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 mb-4 fade-up" style={{ animationDelay: '.13s' }}>

      {/* ── Header ── */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <BarChart2 className="w-3.5 h-3.5 text-brand-500" />
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Campaign Breakdown</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <select value={period} onChange={e => setPeriod(e.target.value)}
              className="appearance-none text-[10px] font-bold text-slate-600 bg-slate-100 rounded-xl px-3 py-1.5 pr-7 focus:outline-none cursor-pointer">
              {PERIOD_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <ChevronDown className="w-3 h-3 text-slate-400 absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" />
          </div>
          {canEdit && !showAdd && (
            <button onClick={() => setShowAdd(true)}
              className="flex items-center gap-1 text-[10px] font-black text-brand-500 hover:bg-brand-50 px-2.5 py-1.5 rounded-xl transition-colors">
              <Plus className="w-3 h-3" />
              Add
            </button>
          )}
        </div>
      </div>

      {showAdd && (
        <AddForm clientId={clientId}
          onAdded={() => { setShowAdd(false); load() }}
          onCancel={() => setShowAdd(false)} />
      )}

      {/* ── Empty state ── */}
      {active.length === 0 ? (
        <div className="text-center py-8">
          <BarChart2 className="w-8 h-8 text-slate-200 mx-auto mb-2" />
          <p className="text-sm text-slate-400 font-semibold">No campaign data for this period</p>
          {canEdit && <p className="text-xs text-slate-300 mt-1">Click Add to enter campaign metrics manually</p>}
        </div>
      ) : (
        <>
          {/* ── Desktop table ── */}
          <div className="hidden sm:block overflow-x-auto -mx-1">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-slate-100">
                  {['Campaign', 'Channel', 'Spend', 'Leads', 'Revenue', 'ROAS', ''].map(h => (
                    <th key={h} className="text-[9px] font-black uppercase tracking-widest text-slate-400 pb-2 pr-4 last:pr-0 pl-1">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {active.map(c => {
                  const style = cs(c.channel)
                  const sp    = parseFloat(c.total_spend)   || 0
                  const rev   = parseFloat(c.total_revenue) || 0
                  const roas  = c.roas != null ? parseFloat(c.roas) : sp > 0 ? rev / sp : null
                  return (
                    <tr key={c.external_id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/50 transition-colors">
                      <td className="py-3 pr-4 pl-1">
                        <p className="text-sm font-bold text-slate-800 leading-tight">{c.name}</p>
                        <p className={`text-[9px] font-black uppercase tracking-wider mt-0.5 ${
                          c.status === 'active' ? 'text-emerald-500' : 'text-slate-300'
                        }`}>{c.status || 'active'}</p>
                      </td>
                      <td className="py-3 pr-4">
                        <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full ${style.bg} ${style.text}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
                          {c.channel}
                        </span>
                      </td>
                      <td className="py-3 pr-4 text-sm font-bold text-slate-700 tabular-nums">{fmt$$(sp)}</td>
                      <td className="py-3 pr-4 text-sm font-bold text-slate-700 tabular-nums">{fmtN(c.total_leads)}</td>
                      <td className="py-3 pr-4 text-sm font-bold text-slate-700 tabular-nums">{fmt$$(rev)}</td>
                      <td className="py-3 pr-4">
                        {roas != null
                          ? <span className={`text-sm font-black tabular-nums ${roasColor(roas)}`}>{roas.toFixed(1)}×</span>
                          : <span className="text-slate-300 text-sm">—</span>
                        }
                      </td>
                      <td className="py-3 text-right">
                        {canEdit && (
                          <button onClick={() => handleDelete(c.external_id)}
                            className="p-1.5 rounded-lg text-slate-200 hover:text-rose-400 hover:bg-rose-50 transition-colors"
                            title="Archive campaign">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* ── Mobile cards ── */}
          <div className="sm:hidden space-y-2">
            {active.map(c => {
              const style = cs(c.channel)
              const sp    = parseFloat(c.total_spend)   || 0
              const rev   = parseFloat(c.total_revenue) || 0
              const roas  = c.roas != null ? parseFloat(c.roas) : sp > 0 ? rev / sp : null
              return (
                <div key={c.external_id} className="flex items-center justify-between bg-slate-50 rounded-xl p-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold text-slate-800 truncate">{c.name}</p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${style.bg} ${style.text}`}>{c.channel}</span>
                      <span className="text-[10px] text-slate-400">{fmt$$(sp)} spend · {fmtN(c.total_leads)} leads</span>
                    </div>
                  </div>
                  <div className="text-right ml-3 shrink-0">
                    <p className="text-sm font-black text-slate-800">{fmt$$(rev)}</p>
                    {roas != null && (
                      <p className={`text-[10px] font-black ${roasColor(roas)}`}>{roas.toFixed(1)}× ROAS</p>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          {/* ── Totals footer ── */}
          {active.length > 1 && (
            <div className="flex items-center justify-between border-t border-slate-100 pt-3 mt-2">
              <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">
                {active.length} campaigns
              </p>
              <div className="flex items-center gap-5">
                <div className="text-right">
                  <p className="text-[9px] font-black uppercase tracking-wider text-slate-400">Spend</p>
                  <p className="text-sm font-black text-slate-700 tabular-nums">{fmt$$(totalSpend)}</p>
                </div>
                <div className="text-right">
                  <p className="text-[9px] font-black uppercase tracking-wider text-slate-400">Revenue</p>
                  <p className="text-sm font-black text-slate-700 tabular-nums">{fmt$$(totalRevenue)}</p>
                </div>
                {overallRoas != null && (
                  <div className="text-right">
                    <p className="text-[9px] font-black uppercase tracking-wider text-slate-400">ROAS</p>
                    <p className={`text-sm font-black tabular-nums ${roasColor(overallRoas)}`}>
                      {overallRoas.toFixed(1)}×
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
