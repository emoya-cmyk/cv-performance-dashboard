import { ArrowUp, ArrowDown, Minus, ExternalLink } from 'lucide-react'
import { fmtN } from '@/lib/utils'

function PositionBadge({ pos }) {
  if (!pos) return <span className="text-slate-500">—</span>
  const cls =
    pos === 1 ? 'bg-amber-400/20 text-amber-300 ring-1 ring-amber-400/30' :
    pos <= 3  ? 'bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/30' :
    pos <= 10 ? 'bg-sky-500/20 text-sky-300 ring-1 ring-sky-500/30' :
    pos <= 20 ? 'bg-slate-500/20 text-slate-300' :
                'bg-rose-500/10 text-rose-400'

  const label =
    pos === 1 ? '🥇 #1' :
    pos <= 3  ? `#${pos}` :
    pos <= 10 ? `#${pos}` :
                `#${pos}`

  return (
    <span className={`inline-flex items-center justify-center rounded-full px-2.5 py-0.5 text-xs font-black tabular-nums min-w-[2.5rem] ${cls}`}>
      {label}
    </span>
  )
}

export default function KeywordRankTable({ keywords = [] }) {
  if (!keywords.length) {
    return (
      <div className="h-full flex items-center justify-center p-8 text-center">
        <div>
          <p className="text-sm font-bold text-slate-400 mb-1">No keyword data yet</p>
          <p className="text-xs text-slate-500">Sync SEMrush to see rankings</p>
        </div>
      </div>
    )
  }

  return (
    <div className="overflow-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-white/[0.06]">
            <th className="text-left text-[10px] font-black uppercase tracking-wider text-slate-500 pb-3 pr-4">Keyword</th>
            <th className="text-center text-[10px] font-black uppercase tracking-wider text-slate-500 pb-3 px-2">Rank</th>
            <th className="text-right text-[10px] font-black uppercase tracking-wider text-slate-500 pb-3 px-2">Volume</th>
            <th className="text-right text-[10px] font-black uppercase tracking-wider text-slate-500 pb-3 pl-2">CPC</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/[0.04]">
          {keywords.map((kw, i) => (
            <tr key={i} className="group hover:bg-white/[0.02] transition-colors">
              <td className="py-2.5 pr-4">
                <div className="flex items-start gap-2">
                  <span className="text-slate-200 font-medium text-xs leading-relaxed">{kw.keyword}</span>
                  {kw.url && (
                    <a
                      href={kw.url.startsWith('http') ? kw.url : `https://${kw.url}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0 mt-0.5"
                    >
                      <ExternalLink className="w-3 h-3 text-slate-500 hover:text-slate-300" />
                    </a>
                  )}
                </div>
              </td>
              <td className="py-2.5 px-2 text-center">
                <PositionBadge pos={kw.position} />
              </td>
              <td className="py-2.5 px-2 text-right text-xs tabular-nums text-slate-400">
                {kw.volume ? fmtN(kw.volume) : '—'}
              </td>
              <td className="py-2.5 pl-2 text-right text-xs tabular-nums text-slate-400">
                {kw.cpc > 0 ? `$${kw.cpc.toFixed(2)}` : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
