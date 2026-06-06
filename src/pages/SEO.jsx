import { useState, useEffect, useCallback } from 'react'
import { useOutletContext } from 'react-router-dom'
import {
  Search, RefreshCw, Globe, AlertTriangle, CheckCircle, Settings, TrendingUp,
} from 'lucide-react'
import {
  LineChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid,
} from 'recharts'
import TopBar from '@/components/TopBar'
import { SkeletonGrid } from '@/components/SkeletonCard'
import { USE_API, api } from '@/lib/api'
import { fmt$, fmtN, weekLabel } from '@/lib/utils'
import OrganicScoreCard from '@/components/seo/OrganicScoreCard'
import KeywordRankTable from '@/components/seo/KeywordRankTable'
import CompetitorCard from '@/components/seo/CompetitorCard'

// ── Empty state: no API key ───────────────────────────────────────────────────
function ConnectState({ domain, onDomainSave }) {
  const [val, setVal] = useState(domain || '')
  const [saving, setSaving] = useState(false)

  async function save(e) {
    e.preventDefault()
    if (!val.trim()) return
    setSaving(true)
    try { await onDomainSave(val.trim()) } finally { setSaving(false) }
  }

  return (
    <div className="flex flex-col items-center justify-center py-20 px-6 text-center max-w-lg mx-auto">
      <div className="w-14 h-14 rounded-2xl bg-sky-500/10 border border-sky-500/20 flex items-center justify-center mb-5">
        <Search className="w-7 h-7 text-sky-400" />
      </div>
      <h2 className="text-xl font-black text-slate-100 mb-2">Connect SEMrush</h2>
      <p className="text-sm text-slate-400 mb-6 leading-relaxed">
        Add <code className="text-sky-400 bg-sky-500/10 px-1 rounded">SEMRUSH_API_KEY</code> to your
        Vercel environment to unlock organic keyword rankings, traffic value, and competitor
        intelligence — alongside your paid channels.
      </p>

      <div className="w-full bg-surface-2 rounded-2xl border border-white/[0.06] p-5 text-left">
        <p className="text-xs font-black uppercase tracking-wider text-slate-400 mb-3">
          Client Website Domain
        </p>
        <form onSubmit={save} className="flex gap-2">
          <input
            type="text"
            placeholder="example.com"
            value={val}
            onChange={e => setVal(e.target.value)}
            className="flex-1 bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-sky-500/50"
          />
          <button
            type="submit"
            disabled={saving || !val.trim()}
            className="px-4 py-2 bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-white text-sm font-bold rounded-xl transition-colors"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </form>
        <p className="text-[10px] text-slate-600 mt-2">
          Then add <code>SEMRUSH_API_KEY</code> in Vercel → Settings → Environment Variables and redeploy.
        </p>
      </div>
    </div>
  )
}

// ── Organic traffic trend chart ───────────────────────────────────────────────
function TrafficTrend({ history }) {
  if (!history?.length) return null
  return (
    <div className="bg-surface-2 rounded-2xl border border-white/[0.06] p-5">
      <p className="text-sm font-bold text-slate-200 mb-1">Organic Traffic Trend</p>
      <p className="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-4">
        Monthly organic visits over time
      </p>
      <ResponsiveContainer width="100%" height={120}>
        <LineChart data={history} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
          <XAxis
            dataKey="date"
            tickFormatter={v => weekLabel(v)}
            tick={{ fontSize: 10, fill: '#64748b' }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tickFormatter={v => fmtN(v)}
            tick={{ fontSize: 10, fill: '#64748b' }}
            axisLine={false}
            tickLine={false}
            width={52}
          />
          <Tooltip
            content={({ active, payload, label }) =>
              active && payload?.length ? (
                <div className="bg-slate-800 border border-white/10 rounded-xl px-3 py-2 text-xs shadow">
                  <p className="text-slate-400 mb-1">{weekLabel(label)}</p>
                  <p className="text-emerald-400 font-black">{fmtN(payload[0]?.value)} visits</p>
                </div>
              ) : null
            }
          />
          <Line
            type="monotone"
            dataKey="organic_traffic"
            stroke="#34d399"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, fill: '#34d399' }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

// ── Paid vs Organic Overlap ───────────────────────────────────────────────────
// Keywords you're PAYING for in Google Ads that you already rank top 10 organically.
function PaidOrganicOverlap({ keywords = [], adsStats = {} }) {
  if (!keywords.length) return null

  // Filter keywords where organic position is 1-10 (already ranking well)
  const page1 = keywords.filter(k => k.position >= 1 && k.position <= 10)
  if (!page1.length) return null

  const potentialSavings = page1.reduce((acc, k) => acc + (k.cpc || 0) * (k.volume || 0) / 1000, 0)

  return (
    <div className="bg-surface-2 rounded-2xl border border-amber-500/20 p-5">
      <div className="flex items-start justify-between mb-3">
        <div>
          <p className="text-sm font-bold text-slate-200">Paid ↔ Organic Overlap</p>
          <p className="text-[10px] font-black uppercase tracking-wider text-amber-400 mt-0.5">
            Keywords you rank for organically — and may also be buying in Google Ads
          </p>
        </div>
        {potentialSavings > 0 && (
          <div className="text-right">
            <p className="text-lg font-black text-amber-400">{fmt$(potentialSavings)}</p>
            <p className="text-[9px] text-slate-500">est. monthly savings opportunity</p>
          </div>
        )}
      </div>
      <div className="space-y-2 mt-3">
        {page1.slice(0, 6).map((k, i) => (
          <div key={i} className="flex items-center gap-3 text-xs">
            <span className="w-6 h-6 rounded-full bg-amber-500/15 text-amber-400 font-black flex items-center justify-center text-[10px] shrink-0">
              #{k.position}
            </span>
            <span className="flex-1 text-slate-300 truncate">{k.keyword}</span>
            <span className="text-slate-500 shrink-0">{fmtN(k.volume)}/mo</span>
            {k.cpc > 0 && (
              <span className="text-amber-400 font-bold shrink-0">${k.cpc.toFixed(2)} CPC</span>
            )}
          </div>
        ))}
      </div>
      <p className="text-[9px] text-slate-600 mt-3">
        Review these in Google Ads — if organic position ≤ 3, pausing paid on these terms often saves budget with minimal traffic loss.
      </p>
    </div>
  )
}

// ── Main SEO Page ─────────────────────────────────────────────────────────────
export default function SEO() {
  const store = useOutletContext()
  const clientId = store?.selectedClient

  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [error,   setError]   = useState(null)

  const load = useCallback(async () => {
    if (!clientId) return
    setLoading(true)
    setError(null)
    try {
      if (USE_API) {
        const result = await api.getSEO(clientId)
        setData(result)
      } else {
        // Mock data for demo/dev
        setData({
          armed: false,
          connected: false,
          domain: null,
          latest: null,
          history: [],
        })
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [clientId])

  useEffect(() => { load() }, [load])

  async function handleSync() {
    if (!clientId) return
    setSyncing(true)
    try {
      await api.syncSEO(clientId)
      await load()
    } catch (err) {
      setError(err.message)
    } finally {
      setSyncing(false)
    }
  }

  async function handleDomainSave(domain) {
    await api.setSEODomain(clientId, domain)
    await load()
  }

  const keywords    = data?.latest?.top_keywords || []
  const competitors = data?.latest?.competitors  || []

  return (
    <div>
      <TopBar
        title="SEO Intelligence"
        subtitle="Organic search rankings, traffic value & competitor gap"
        {...store}
        onClientChange={store?.setSelectedClient}
        onPeriodChange={store?.setSelectedPeriod}
      />

      {loading ? (
        <>
          <SkeletonGrid count={4} />
          <SkeletonGrid count={2} />
        </>
      ) : !data?.armed || !data?.connected ? (
        <ConnectState domain={data?.domain} onDomainSave={handleDomainSave} />
      ) : (
        <div className="px-6 pb-8 space-y-4">

          {/* Status bar */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <CheckCircle className="w-3.5 h-3.5 text-emerald-400" />
              <span>
                {data.domain} · last sync{' '}
                {data.latest?.snapshot_date ? weekLabel(data.latest.snapshot_date) : 'never'}
              </span>
            </div>
            <button
              onClick={handleSync}
              disabled={syncing}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-xs font-bold text-slate-300 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-3 h-3 ${syncing ? 'animate-spin' : ''}`} />
              {syncing ? 'Syncing…' : 'Sync Now'}
            </button>
          </div>

          {error && (
            <div className="flex items-center gap-2 bg-rose-500/10 border border-rose-500/20 rounded-xl px-4 py-3 text-xs text-rose-400">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              {error}
            </div>
          )}

          {/* Row 1: Metric cards */}
          <OrganicScoreCard
            latest={data.latest}
            history={data.history}
            domain={data.domain}
          />

          {/* Row 2: Keywords + Competitors */}
          <div className="grid grid-cols-1 xl:grid-cols-5 gap-4">
            {/* Keyword ranking table — 3/5 width */}
            <div className="xl:col-span-3 bg-surface-2 rounded-2xl border border-white/[0.06] flex flex-col">
              <div className="px-5 py-4 border-b border-white/[0.06] flex-shrink-0 flex items-center justify-between">
                <div>
                  <p className="text-sm font-bold text-slate-200">Keyword Rankings</p>
                  <p className="text-[10px] font-black uppercase tracking-wider text-slate-400 mt-0.5">
                    Top organic positions on Google
                  </p>
                </div>
                <div className="flex gap-2 text-[9px]">
                  {[
                    { label: '#1',    color: 'bg-amber-400/20 text-amber-300'   },
                    { label: 'Top 3', color: 'bg-emerald-500/20 text-emerald-300' },
                    { label: 'Top 10',color: 'bg-sky-500/20 text-sky-300'       },
                  ].map(({ label, color }) => (
                    <span key={label} className={`px-1.5 py-0.5 rounded-full font-black ${color}`}>
                      {label}
                    </span>
                  ))}
                </div>
              </div>
              <div className="flex-1 px-5 py-4 overflow-auto">
                <KeywordRankTable keywords={keywords} />
              </div>
            </div>

            {/* Competitor card — 2/5 width */}
            <div className="xl:col-span-2 bg-surface-2 rounded-2xl border border-white/[0.06] flex flex-col">
              <div className="px-5 py-4 border-b border-white/[0.06] flex-shrink-0">
                <p className="text-sm font-bold text-slate-200">Organic Competitors</p>
                <p className="text-[10px] font-black uppercase tracking-wider text-slate-400 mt-0.5">
                  Domains competing for the same keywords
                </p>
              </div>
              <div className="flex-1 px-5 py-4 overflow-auto">
                <CompetitorCard competitors={competitors} />
              </div>
            </div>
          </div>

          {/* Row 3: Paid vs Organic Overlap */}
          <PaidOrganicOverlap keywords={keywords} />

          {/* Row 4: Traffic trend */}
          {data.history?.length > 1 && <TrafficTrend history={data.history} />}

        </div>
      )}
    </div>
  )
}
