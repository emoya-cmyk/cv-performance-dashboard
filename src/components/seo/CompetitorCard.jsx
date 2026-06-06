import { fmtN } from '@/lib/utils'
import { ExternalLink } from 'lucide-react'

function Bar({ pct, color = 'bg-sky-500' }) {
  return (
    <div className="flex-1 h-1 bg-white/10 rounded-full overflow-hidden">
      <div className={`h-full ${color} rounded-full`} style={{ width: `${Math.min(pct, 100)}%` }} />
    </div>
  )
}

export default function CompetitorCard({ competitors = [] }) {
  if (!competitors.length) {
    return (
      <div className="h-full flex items-center justify-center p-6 text-center">
        <div>
          <p className="text-sm font-bold text-slate-400 mb-1">No competitor data</p>
          <p className="text-xs text-slate-500">Sync SEMrush to see organic competitors</p>
        </div>
      </div>
    )
  }

  const maxKW = Math.max(...competitors.map(c => c.organic_keywords), 1)

  return (
    <div className="space-y-3">
      {competitors.map((c, i) => (
        <div key={i} className="rounded-xl bg-white/[0.03] border border-white/[0.05] px-4 py-3">
          <div className="flex items-center justify-between mb-2">
            <a
              href={`https://${c.domain}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 group"
            >
              <span className="text-xs font-bold text-slate-200 group-hover:text-white transition-colors truncate max-w-[140px]">
                {c.domain}
              </span>
              <ExternalLink className="w-3 h-3 text-slate-500 group-hover:text-slate-300 shrink-0" />
            </a>
            <span className="text-[10px] font-black text-sky-400 shrink-0 ml-2">
              {c.common_keywords > 0 ? `${fmtN(c.common_keywords)} shared` : ''}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <Bar pct={(c.organic_keywords / maxKW) * 100} color="bg-sky-500" />
            <span className="text-[10px] text-slate-500 w-20 text-right shrink-0">
              {fmtN(c.organic_keywords)} kws
            </span>
          </div>

          {c.common_pct > 0 && (
            <p className="text-[9px] text-slate-600 mt-1">
              {c.common_pct.toFixed(0)}% keyword overlap
            </p>
          )}
        </div>
      ))}
    </div>
  )
}
