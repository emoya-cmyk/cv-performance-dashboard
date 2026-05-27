import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts'
import { fmt$$, fmtN, fmtX, fmtPct, weekLabel } from '@/lib/utils'
import { api } from '@/lib/api'
import { applyBrandColor } from '@/lib/agencySettings'

// ── tiny helpers ──────────────────────────────────────────────────────────────
function delta(curr, prev) {
  if (!prev || prev === 0) return null
  return ((curr - prev) / prev) * 100
}
function DeltaBadge({ pct }) {
  if (pct === null) return null
  const up = pct >= 0
  return (
    <span className={`inline-flex items-center gap-0.5 text-[10px] font-black px-2 py-0.5 rounded-full ${
      up ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-600'
    }`}>
      {up ? '↑' : '↓'} {Math.abs(pct).toFixed(0)}%
    </span>
  )
}

// ── Mini goal ring (SVG) ──────────────────────────────────────────────────────
function MiniRing({ pct, label, color }) {
  const SIZE = 72, STROKE = 7, R = (SIZE - STROKE) / 2
  const CIRC = 2 * Math.PI * R
  const p    = Math.min(pct, 100)
  return (
    <div className="flex flex-col items-center gap-1">
      <svg width={SIZE} height={SIZE} className="-rotate-90">
        <circle cx={SIZE/2} cy={SIZE/2} r={R} fill="none" stroke="#f1f5f9" strokeWidth={STROKE} />
        <circle cx={SIZE/2} cy={SIZE/2} r={R} fill="none" stroke={color}
          strokeWidth={STROKE} strokeLinecap="round"
          strokeDasharray={CIRC} strokeDashoffset={CIRC - (p / 100) * CIRC}
          style={{ transition: 'stroke-dashoffset 800ms ease-out' }}
        />
      </svg>
      <div className="-mt-[44px] flex flex-col items-center pointer-events-none">
        <p className="text-sm font-black leading-none" style={{ color }}>{p.toFixed(0)}%</p>
      </div>
      <p className="mt-7 text-[10px] font-bold text-slate-400 text-center">{label}</p>
    </div>
  )
}

// ── Channel attribution bar ───────────────────────────────────────────────────
function ChannelBar({ stats }) {
  const channels = [
    { key: 'ads',     label: 'Google Ads',  leads: stats.ads_leads,  color: '#3b82f6' },
    { key: 'lsa',     label: 'Google LSA',  leads: stats.lsa_calls,  color: '#06b6d4' },
    { key: 'meta',    label: 'Meta Ads',    leads: stats.meta_leads, color: '#6366f1' },
    { key: 'gbp',     label: 'GBP / Local', leads: stats.gbp_calls,  color: '#10b981' },
  ].filter(c => c.leads > 0)
  const total = channels.reduce((s, c) => s + c.leads, 0)
  if (channels.length < 2 || total === 0) return null
  return (
    <div>
      <div className="flex rounded-full overflow-hidden h-3 mb-3">
        {channels.map(c => (
          <div key={c.key} style={{ width: `${(c.leads / total) * 100}%`, background: c.color }} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {channels.map(c => (
          <div key={c.key} className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: c.color }} />
            <span className="text-xs text-slate-600 font-semibold">{c.label}</span>
            <span className="text-xs text-slate-400">· {fmtN(c.leads)} leads · {((c.leads / total) * 100).toFixed(0)}%</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Status badge for team update ─────────────────────────────────────────────
const STATUS_MAP = {
  on_track:  { label: 'On Track',          color: 'bg-emerald-100 text-emerald-700' },
  monitoring:{ label: 'Monitoring',         color: 'bg-amber-100 text-amber-700'    },
  adjusted:  { label: 'Strategy Adjusted',  color: 'bg-blue-100 text-blue-700'      },
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function SharedReport() {
  const { token } = useParams()
  const [data,    setData]    = useState(null)
  const [status,  setStatus]  = useState('loading')   // loading | ok | revoked | expired | error

  useEffect(() => {
    api.getShareData(token)
      .then(d  => {
        setData(d)
        setStatus('ok')
        if (d.agency?.accent_hex) applyBrandColor(d.agency.accent_hex)
      })
      .catch(err => {
        const msg = err.message.toLowerCase()
        if (msg.includes('revoked'))  setStatus('revoked')
        else if (msg.includes('expired') || msg.includes('410')) setStatus('expired')
        else setStatus('error')
      })
  }, [token])

  // ── Loading ──
  if (status === 'loading') {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-slate-400 text-sm animate-pulse">Loading report…</div>
      </div>
    )
  }

  // ── Error states ──
  if (status !== 'ok') {
    const msgs = {
      revoked: { title: 'Report Unavailable', body: 'This report link has been revoked by the agency.' },
      expired: { title: 'Link Expired',        body: 'This report link has expired. Ask your agency for a new link.' },
      error:   { title: 'Not Found',            body: 'This report link doesn\'t exist or may have been removed.' },
    }
    const m = msgs[status]
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-8 max-w-sm w-full text-center">
          <div className="w-12 h-12 rounded-2xl bg-slate-100 flex items-center justify-center mx-auto mb-4">
            <span className="text-2xl">🔒</span>
          </div>
          <h1 className="text-lg font-black text-slate-900 mb-2">{m.title}</h1>
          <p className="text-sm text-slate-500 leading-relaxed">{m.body}</p>
          <p className="text-xs text-slate-300 mt-6">Powered by 10X Marketing Dashboard</p>
        </div>
      </div>
    )
  }

  const { client, stats, prevStats, trend, goal, update, share } = data
  const agency = data.agency || { agency_name: '10X Performance', accent_hex: '#e53935', logo_url: null, contact_email: null, calendar_url: null }

  // Compute period dates
  const revDelta = data.revDelta
  const jobDelta = delta(stats.total_closed, prevStats?.total_closed)
  const roasDelta = delta(stats.roas, prevStats?.roas)

  // Goal progress
  const revPct   = goal?.revenue_target > 0 ? Math.min((stats.total_revenue / goal.revenue_target) * 100, 100) : null
  const leadsPct = goal?.leads_target   > 0 ? Math.min((stats.total_leads   / goal.leads_target  ) * 100, 100) : null
  const jobsPct  = goal?.jobs_target    > 0 ? Math.min((stats.total_closed  / goal.jobs_target   ) * 100, 100) : null
  const showGoals = revPct !== null || leadsPct !== null || jobsPct !== null

  // Expiry label
  const expiryLabel = share.expires_at
    ? `Expires ${new Date(share.expires_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
    : 'No expiry'

  const statusStyle = STATUS_MAP[update?.status] || STATUS_MAP.on_track

  return (
    <div className="min-h-screen bg-slate-50">
      {/* ── Top bar ── */}
      <div className="bg-white border-b border-slate-100 px-5 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          {agency.logo_url ? (
            <img src={agency.logo_url} alt={agency.agency_name} className="h-7 w-auto" />
          ) : (
            <div className="w-7 h-7 rounded-lg bg-brand-500 flex items-center justify-center">
              <svg viewBox="0 0 24 24" fill="none" className="w-4 h-4"><path d="M3 17l4-8 4 4 4-6 4 10" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </div>
          )}
          <span className="text-xs font-black text-slate-600">{agency.agency_name}</span>
        </div>
        <div className="flex items-center gap-3 text-[10px] text-slate-400 font-semibold">
          <span>{expiryLabel}</span>
          <span>·</span>
          <span>{share.access_count} {share.access_count === 1 ? 'view' : 'views'}</span>
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-4 py-8 space-y-4">

        {/* ── Hero ── */}
        <div className="bg-[#0a0a0a] rounded-2xl p-6 text-white overflow-hidden relative">
          <div className="absolute inset-0 opacity-10"
            style={{ background: `radial-gradient(circle at 80% 50%, ${agency.accent_hex || '#e53935'} 0%, transparent 60%)` }} />
          <div className="relative">
            <p className="text-[10px] font-black uppercase tracking-widest text-white/50 mb-1">
              {client.name} · Last 4 Weeks
            </p>
            <h1 className="text-2xl font-black text-white mb-4">Your Results</h1>

            <div className="grid grid-cols-3 gap-3">
              {[
                { label: 'Revenue',   value: fmt$$(stats.total_revenue), d: revDelta },
                { label: 'Jobs Won',  value: fmtN(stats.total_closed),   d: jobDelta  },
                { label: 'Ad Return', value: fmtX(stats.roas) + ' ROAS', d: roasDelta },
              ].map(m => (
                <div key={m.label} className="bg-white/5 rounded-xl p-3">
                  <p className="text-[9px] font-black uppercase tracking-widest text-white/40 mb-1">{m.label}</p>
                  <p className="text-lg font-black text-white leading-none">{m.value}</p>
                  <div className="mt-1.5"><DeltaBadge pct={m.d} /></div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── Goal Rings ── */}
        {showGoals && (
          <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5">
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-4">Monthly Goal Progress</p>
            <div className="flex justify-around">
              {revPct   !== null && <MiniRing pct={revPct}   label="Revenue"   color={revPct  >=80?'#10b981':revPct  >=50?'#f59e0b':'#e53935'} />}
              {leadsPct !== null && <MiniRing pct={leadsPct} label="Leads"     color={leadsPct>=80?'#10b981':leadsPct>=50?'#f59e0b':'#e53935'} />}
              {jobsPct  !== null && <MiniRing pct={jobsPct}  label="Jobs Won"  color={jobsPct >=80?'#10b981':jobsPct >=50?'#f59e0b':'#e53935'} />}
            </div>
          </div>
        )}

        {/* ── Channel Attribution ── */}
        {stats.total_leads > 0 && (
          <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5">
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-3">Where Your Leads Came From</p>
            <ChannelBar stats={stats} />
          </div>
        )}

        {/* ── Revenue Trend ── */}
        {trend.length > 1 && (
          <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5">
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">Revenue Trend</p>
            <p className="text-xl font-black text-slate-900 mb-4">{fmt$$(stats.total_revenue)}</p>
            <ResponsiveContainer width="100%" height={140}>
              <AreaChart data={trend} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor={agency.accent_hex || '#e53935'} stopOpacity={0.15} />
                    <stop offset="95%" stopColor={agency.accent_hex || '#e53935'} stopOpacity={0}    />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="week" tickFormatter={v => weekLabel(v)}
                  tick={{ fill: '#94a3b8', fontSize: 10 }} axisLine={false} tickLine={false} />
                <YAxis hide />
                <Tooltip formatter={v => fmt$$(v)} labelFormatter={v => weekLabel(v)}
                  contentStyle={{ borderRadius: '10px', border: '1px solid #e2e8f0', fontSize: 12 }} />
                <Area type="monotone" dataKey="revenue" stroke={agency.accent_hex || '#e53935'} strokeWidth={2}
                  fill="url(#revGrad)" dot={false} />
              </AreaChart>
            </ResponsiveContainer>
            <p className="text-xs text-slate-400 mt-2">Weekly revenue — last 8 weeks</p>
          </div>
        )}

        {/* ── Agency Update ── */}
        {update?.this_week && (
          <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5">
            <div className="flex items-center justify-between mb-3">
              <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">From Your Team</p>
              {update.week_start && (
                <p className="text-[9px] text-slate-400">Week of {weekLabel(update.week_start)}</p>
              )}
            </div>
            <span className={`text-[10px] font-black px-2 py-0.5 rounded-full mb-3 inline-block ${statusStyle.color}`}>
              {statusStyle.label}
            </span>
            <p className="text-sm text-slate-700 leading-relaxed">{update.this_week}</p>
            {update.next_week && (
              <div className="border-t border-slate-100 pt-3 mt-3">
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">Next Week's Focus</p>
                <p className="text-sm text-slate-600 leading-relaxed">{update.next_week}</p>
              </div>
            )}
          </div>
        )}

        {/* ── Contact CTA ── */}
        {(agency.contact_email || agency.calendar_url) && (
          <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 text-center">
            <p className="text-sm font-black text-slate-900 mb-1">Questions about your results?</p>
            <p className="text-xs text-slate-500 mb-4">Your account team is here to help.</p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
              {agency.contact_email && (
                <a
                  href={`mailto:${agency.contact_email}`}
                  className="inline-flex items-center gap-1.5 text-xs font-black text-white bg-brand-500 hover:bg-brand-600 transition-colors px-4 py-2 rounded-xl"
                >
                  ✉ Email Your Team
                </a>
              )}
              {agency.calendar_url && (
                <a
                  href={agency.calendar_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs font-black text-slate-600 border border-slate-200 hover:border-slate-300 transition-colors px-4 py-2 rounded-xl"
                >
                  📅 Schedule a Call
                </a>
              )}
            </div>
          </div>
        )}

        {/* ── Footer ── */}
        <div className="text-center py-4">
          <p className="text-[10px] text-slate-300 font-semibold">
            Powered by {agency.agency_name} · {expiryLabel}
          </p>
        </div>
      </div>
    </div>
  )
}
