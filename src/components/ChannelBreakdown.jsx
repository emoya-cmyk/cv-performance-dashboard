// Change 3: horizontal bar rows — Spend · Volume · Return
import { fmt$$, fmtN, fmtX } from '@/lib/utils'

const CHANNELS = [
  {
    key:         'google',
    label:       'Google Ads',
    dot:         'bg-blue-500',
    spend:       s => s.ads_spend  || 0,
    volume:      s => s.ads_leads  || 0,
    volumeLabel: 'leads',
    cpl:         s => (s.ads_leads  || 0) > 0 ? (s.ads_spend  || 0) / s.ads_leads  : 0,
    roas:        s => s.ads_roas   || 0,
    hasRoas:     true,
  },
  {
    key:         'meta',
    label:       'Meta Ads',
    dot:         'bg-indigo-500',
    spend:       s => s.meta_spend || 0,
    volume:      s => s.meta_leads || 0,
    volumeLabel: 'leads',
    cpl:         s => (s.meta_leads || 0) > 0 ? (s.meta_spend || 0) / s.meta_leads : 0,
    roas:        s => s.meta_roas  || 0,
    hasRoas:     true,
  },
  {
    key:         'lsa',
    label:       'LSA',
    dot:         'bg-emerald-500',
    spend:       s => s.lsa_spend  || 0,
    volume:      s => s.lsa_calls  || 0,
    volumeLabel: 'calls',
    cpl:         s => (s.lsa_calls  || 0) > 0 ? (s.lsa_spend  || 0) / s.lsa_calls  : 0,
    roas:        () => 0,  // LSA tracked via CPL + booking rate, not ROAS
    hasRoas:     false,
  },
]

function roasStyle(roas) {
  if (roas >= 8)   return { bar: 'bg-emerald-500', text: 'text-emerald-400', label: 'Strong' }
  if (roas >= 4)   return { bar: 'bg-amber-400',   text: 'text-amber-400',   label: 'OK'     }
  if (roas > 0)    return { bar: 'bg-rose-500',     text: 'text-rose-400',   label: 'Low'    }
  return               { bar: 'bg-slate-400',       text: 'text-slate-400',  label: '—'     }
}

export default function ChannelBreakdown({ stats = {} }) {
  const active = CHANNELS.filter(ch => ch.spend(stats) > 0)

  // Max ROAS across active channels — sets bar scale (min 5 so bars aren't all 100%)
  const maxRoas = Math.max(...CHANNELS.map(ch => ch.roas(stats)), 5)

  if (active.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-6 text-center">
        <p className="text-xs font-black uppercase tracking-wider text-slate-400 mb-2">
          No Channels Connected
        </p>
        <p className="text-sm text-slate-500 leading-relaxed">
          Add Google Ads, Meta, or LSA<br />in Connections to see spend here.
        </p>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-5 py-4 border-b border-white/[0.06] flex-shrink-0">
        <p className="text-sm font-bold text-slate-200">Channels at a Glance</p>
        <p className="text-[10px] font-black uppercase tracking-wider text-slate-400 mt-0.5">
          Spend · Volume · Return
        </p>
      </div>

      {/* Rows */}
      <div className="flex-1 flex flex-col justify-around px-5 py-1">
        {CHANNELS.map(ch => {
          const spend  = ch.spend(stats)
          if (spend === 0) return null

          const volume = ch.volume(stats)
          const cpl    = ch.cpl(stats)
          const roas   = ch.roas(stats)
          const barPct = ch.hasRoas && roas > 0 ? Math.min((roas / maxRoas) * 100, 100) : 0
          const style  = roasStyle(roas)

          return (
            <div key={ch.key} className="py-3.5 border-b border-white/[0.04] last:border-0">

              {/* Top row: label + spend + volume */}
              <div className="flex items-start justify-between mb-2.5">
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full shrink-0 mt-0.5 ${ch.dot}`} />
                  <span className="text-sm font-bold text-slate-200">{ch.label}</span>
                </div>
                <div className="flex items-start gap-5 text-right">
                  <div>
                    <p className="text-sm font-black text-slate-100 leading-none">{fmt$$(spend)}</p>
                    <p className="text-[9px] text-slate-400 uppercase tracking-wide mt-0.5">spend</p>
                  </div>
                  <div>
                    <p className="text-sm font-black text-slate-100 leading-none">{fmtN(volume)}</p>
                    <p className="text-[9px] text-slate-400 uppercase tracking-wide mt-0.5">
                      {ch.volumeLabel}
                      {cpl > 0 ? <> · {fmt$$(cpl)} ea</> : ''}
                    </p>
                  </div>
                </div>
              </div>

              {/* ROAS bar — only for channels that have ROAS */}
              {ch.hasRoas ? (
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-1.5 bg-white/10 rounded-full overflow-hidden">
                    <div
                      className={`h-full ${style.bar} rounded-full transition-all duration-700`}
                      style={{ width: `${barPct}%` }}
                    />
                  </div>
                  <span className={`text-xs font-black w-10 text-right tabular-nums ${style.text}`}>
                    {roas > 0 ? fmtX(roas) : '—'}
                  </span>
                  <span className="text-[9px] text-slate-400 w-9">ROAS</span>
                </div>
              ) : (
                /* LSA: show CPL bar against a fixed $150 scale */
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-1.5 bg-white/10 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-emerald-400 rounded-full"
                      style={{ width: cpl > 0 ? `${Math.min((cpl / 150) * 100, 100)}%` : '0%' }}
                    />
                  </div>
                  <span className="text-xs font-black w-10 text-right text-slate-200 tabular-nums">
                    {cpl > 0 ? fmt$$(cpl) : '—'}
                  </span>
                  <span className="text-[9px] text-slate-400 w-9">/ call</span>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
