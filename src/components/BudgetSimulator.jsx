import { useState } from 'react'
import { Sliders } from 'lucide-react'
import { fmt$$, fmtN } from '@/lib/utils'

const PRESETS = [250, 500, 1000, 2500, 5000]

/**
 * "What If" Budget Simulator — shown on the client view.
 *
 * Lets a business owner slide a budget and see projected additional
 * leads / jobs / revenue based on their actual CPL and close rate.
 *
 * This is a retention + upsell tool: clients who play with it
 * routinely ask their agency to increase spend.
 */
export default function BudgetSimulator({ stats = {} }) {
  const [addBudget, setAddBudget] = useState(500)

  // Pull live metrics — fall back to conservative industry defaults if missing
  const cpl = (
    stats.ads_cpl ||
    (stats.ads_leads  > 0 ? (stats.ads_spend  || 0) / stats.ads_leads  : 0) ||
    (stats.meta_leads > 0 ? (stats.meta_spend || 0) / stats.meta_leads : 0) ||
    55
  )
  const closeRate  = stats.total_leads > 0
    ? Math.max((stats.total_closed || 0) / stats.total_leads, 0.05)
    : 0.15
  const avgJobVal  = stats.total_closed > 0
    ? (stats.total_revenue || 0) / stats.total_closed
    : 4500

  const projLeads = Math.round(addBudget / cpl)
  const projJobs  = Math.max(Math.round(projLeads * closeRate), projLeads > 0 ? 1 : 0)
  const projRev   = Math.round(projJobs * avgJobVal)

  const pct = ((addBudget - 100) / (5000 - 100)) * 100

  return (
    <div
      className="rounded-2xl p-5 mb-4"
      style={{ background: 'linear-gradient(135deg, #0f172a 0%, #1e1b4b 100%)' }}
    >
      {/* Header */}
      <div className="flex items-center gap-2.5 mb-4">
        <div className="w-7 h-7 rounded-xl bg-brand-500/20 border border-brand-500/30 flex items-center justify-center shrink-0">
          <Sliders className="w-3.5 h-3.5 text-brand-400" />
        </div>
        <div>
          <p className="text-[10px] font-black uppercase tracking-widest text-white/40">What If Simulator</p>
          <p className="text-xs text-white/60 font-medium">Drag to project your growth</p>
        </div>
      </div>

      {/* Prompt */}
      <p className="text-white text-sm font-semibold leading-snug mb-4">
        What would an extra{' '}
        <span className="font-black text-brand-400 tabular-nums">{fmt$$(addBudget)}/mo</span>{' '}
        in ad budget produce?
      </p>

      {/* Slider */}
      <div className="mb-5">
        <div className="relative mb-1">
          {/* Track fill */}
          <div className="w-full h-1.5 bg-white/10 rounded-full overflow-hidden">
            <div
              className="h-full bg-brand-500 rounded-full transition-none"
              style={{ width: `${pct}%` }}
            />
          </div>
          <input
            type="range"
            min={100} max={5000} step={50}
            value={addBudget}
            onChange={e => setAddBudget(+e.target.value)}
            className="absolute inset-0 w-full opacity-0 cursor-pointer h-1.5"
            style={{ top: 0 }}
          />
        </div>
        {/* Preset chips */}
        <div className="flex justify-between mt-2">
          {PRESETS.map(s => (
            <button
              key={s}
              onClick={() => setAddBudget(s)}
              className={`text-[9px] font-black px-1.5 py-0.5 rounded-md transition-colors ${
                addBudget === s
                  ? 'bg-brand-500/20 text-brand-400 border border-brand-500/30'
                  : 'text-white/25 hover:text-white/50'
              }`}
            >
              {fmt$$(s)}
            </button>
          ))}
        </div>
      </div>

      {/* Projected output */}
      <div className="grid grid-cols-3 gap-2">
        {[
          {
            label: 'Est. Leads',
            value: `+${fmtN(projLeads)}`,
            sub:   `at ${fmt$$(Math.round(cpl))} CPL`,
            color: 'text-blue-400',
            bg:    'bg-blue-500/10 border-blue-500/20',
          },
          {
            label: 'Est. Jobs',
            value: `+${fmtN(projJobs)}`,
            sub:   `${Math.round(closeRate * 100)}% close rate`,
            color: 'text-amber-400',
            bg:    'bg-amber-500/10 border-amber-500/20',
          },
          {
            label: 'Est. Revenue',
            value: `+${fmt$$(projRev)}`,
            sub:   `${fmt$$(Math.round(avgJobVal))} avg job`,
            color: 'text-emerald-400',
            bg:    'bg-emerald-500/10 border-emerald-500/20',
          },
        ].map(item => (
          <div
            key={item.label}
            className={`rounded-xl p-3 text-center border ${item.bg} transition-all duration-200`}
          >
            <p className={`text-xl font-black tabular-nums leading-none ${item.color}`}>
              {item.value}
            </p>
            <p className="text-[9px] font-black text-white/40 uppercase tracking-wide mt-1.5">
              {item.label}
            </p>
            <p className="text-[8px] text-white/20 mt-0.5 leading-tight">{item.sub}</p>
          </div>
        ))}
      </div>

      <p className="text-[8px] text-white/15 mt-3 text-center leading-relaxed">
        Projections use your current CPL &amp; close rate. Actual results vary with market conditions.
      </p>
    </div>
  )
}
