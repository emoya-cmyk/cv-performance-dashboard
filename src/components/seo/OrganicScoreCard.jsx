import { TrendingUp, TrendingDown, Minus, ExternalLink } from 'lucide-react'
import { fmt$, fmtN } from '@/lib/utils'

function DeltaBadge({ value, prev }) {
  if (!prev || prev === 0) return null
  const pct = ((value - prev) / prev) * 100
  const up  = pct >= 0
  const Icon = pct > 1 ? TrendingUp : pct < -1 ? TrendingDown : Minus
  const cls  = pct > 1 ? 'text-emerald-400 bg-emerald-500/10' : pct < -1 ? 'text-rose-400 bg-rose-500/10' : 'text-slate-400 bg-white/5'
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-black rounded-full px-2 py-0.5 ${cls}`}>
      <Icon className="w-3 h-3" />
      {Math.abs(pct).toFixed(0)}%
    </span>
  )
}

export default function OrganicScoreCard({ latest, history, domain }) {
  const prev = history?.length > 1 ? history[history.length - 2] : null

  const cards = [
    {
      label:  'Organic Keywords',
      value:  fmtN(latest?.organic_keywords),
      prev:   prev?.organic_keywords,
      cur:    latest?.organic_keywords,
      sub:    'ranking on Google',
      color:  'text-sky-400',
      accent: 'bg-sky-500/10',
    },
    {
      label:  'Monthly Organic Visits',
      value:  fmtN(latest?.organic_traffic),
      prev:   prev?.organic_traffic,
      cur:    latest?.organic_traffic,
      sub:    'free traffic/mo',
      color:  'text-emerald-400',
      accent: 'bg-emerald-500/10',
    },
    {
      label:  'Traffic Value',
      value:  fmt$(latest?.traffic_value),
      prev:   prev?.traffic_value,
      cur:    latest?.traffic_value,
      sub:    'what this traffic costs in paid ads',
      color:  'text-violet-400',
      accent: 'bg-violet-500/10',
    },
    {
      label:  'Domain Rank',
      value:  latest?.domain_rank ? `#${fmtN(latest.domain_rank)}` : '—',
      prev:   null,
      cur:    null,
      sub:    'SEMrush authority score',
      color:  'text-amber-400',
      accent: 'bg-amber-500/10',
    },
  ]

  return (
    <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
      {cards.map(c => (
        <div key={c.label} className="bg-surface-2 rounded-2xl border border-white/[0.06] p-5">
          <div className="flex items-start justify-between mb-3">
            <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">{c.label}</p>
            {c.prev != null && (
              <DeltaBadge value={c.cur} prev={c.prev} />
            )}
          </div>
          <p className={`text-2xl font-black tabular-nums ${c.color}`}>{c.value || '—'}</p>
          <p className="text-[10px] text-slate-500 mt-1">{c.sub}</p>
          {domain && (
            <p className="text-[9px] text-slate-600 mt-2 truncate">{domain}</p>
          )}
        </div>
      ))}
    </div>
  )
}
