import { useEffect, useRef } from 'react'
import { fmt$$, fmtN } from '@/lib/utils'

/**
 * GoalRing — circular progress ring + lead/jobs bars
 *
 * Props:
 *   revenue        — current period revenue
 *   leads          — current period leads
 *   jobs           — current period jobs
 *   goal           — { revenue_target, leads_target, jobs_target } or null
 *   periodLabel    — e.g. "Last 30 Days"
 */
export default function GoalRing({ revenue = 0, leads = 0, jobs = 0, goal, periodLabel }) {
  if (!goal || (!goal.revenue_target && !goal.leads_target && !goal.jobs_target)) return null

  const revTarget  = goal.revenue_target || 0
  const leadsTarget = goal.leads_target  || 0
  const jobsTarget  = goal.jobs_target   || 0

  const revPct   = revTarget   > 0 ? Math.min((revenue / revTarget)   * 100, 100) : null
  const leadsPct = leadsTarget > 0 ? Math.min((leads   / leadsTarget) * 100, 100) : null
  const jobsPct  = jobsTarget  > 0 ? Math.min((jobs    / jobsTarget)  * 100, 100) : null

  // Color based on progress
  function pctColor(pct) {
    if (pct === null) return { ring: 'stroke-slate-100', text: 'text-slate-400' }
    if (pct >= 80) return { ring: 'stroke-emerald-500', text: 'text-emerald-600', bar: 'bg-emerald-500' }
    if (pct >= 50) return { ring: 'stroke-amber-500',   text: 'text-amber-600',   bar: 'bg-amber-500'   }
    return           { ring: 'stroke-rose-500',   text: 'text-rose-600',   bar: 'bg-rose-500'   }
  }

  const revColor = pctColor(revPct)

  // SVG ring math
  const SIZE   = 140
  const STROKE = 10
  const R      = (SIZE - STROKE) / 2
  const CIRC   = 2 * Math.PI * R
  const offset = revPct !== null ? CIRC - (revPct / 100) * CIRC : CIRC

  const toGo = revTarget > 0 ? Math.max(revTarget - revenue, 0) : 0

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 mb-4 fade-up">
      <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-4">
        Monthly Goal Progress
      </p>

      <div className="flex items-center gap-6">
        {/* ── Revenue ring ── */}
        {revPct !== null && (
          <div className="flex flex-col items-center shrink-0">
            <svg width={SIZE} height={SIZE} className="-rotate-90">
              {/* Track */}
              <circle
                cx={SIZE / 2} cy={SIZE / 2} r={R}
                fill="none"
                stroke="#f1f5f9"
                strokeWidth={STROKE}
              />
              {/* Progress */}
              <circle
                cx={SIZE / 2} cy={SIZE / 2} r={R}
                fill="none"
                className={revColor.ring}
                strokeWidth={STROKE}
                strokeLinecap="round"
                strokeDasharray={CIRC}
                strokeDashoffset={offset}
                style={{ transition: 'stroke-dashoffset 800ms ease-out' }}
              />
            </svg>
            {/* Center label — rotated back up */}
            <div className="-mt-[76px] flex flex-col items-center pointer-events-none">
              <p className={`text-xl font-black leading-none ${revColor.text}`}>
                {revPct.toFixed(0)}%
              </p>
              <p className="text-[9px] text-slate-400 font-bold mt-0.5">of goal</p>
            </div>
            <div className="mt-10 text-center">
              <p className="text-[10px] text-slate-500 font-bold">Revenue Goal</p>
              <p className="text-xs font-black text-slate-700">{fmt$$(revTarget)}</p>
            </div>
          </div>
        )}

        {/* ── Leads + Jobs bars ── */}
        <div className="flex-1 space-y-4">
          {leadsPct !== null && (() => {
            const c = pctColor(leadsPct)
            return (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <p className="text-[11px] font-black text-slate-500 uppercase tracking-wide">Leads</p>
                  <p className="text-[11px] font-bold text-slate-600">
                    {fmtN(leads)} <span className="text-slate-400">/ {fmtN(leadsTarget)}</span>
                  </p>
                </div>
                <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-700 ${c.bar}`}
                    style={{ width: `${leadsPct}%` }}
                  />
                </div>
                <p className={`text-[10px] font-bold mt-0.5 ${c.text}`}>{leadsPct.toFixed(0)}%</p>
              </div>
            )
          })()}

          {jobsPct !== null && (() => {
            const c = pctColor(jobsPct)
            return (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <p className="text-[11px] font-black text-slate-500 uppercase tracking-wide">Jobs Won</p>
                  <p className="text-[11px] font-bold text-slate-600">
                    {fmtN(jobs)} <span className="text-slate-400">/ {fmtN(jobsTarget)}</span>
                  </p>
                </div>
                <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-700 ${c.bar}`}
                    style={{ width: `${jobsPct}%` }}
                  />
                </div>
                <p className={`text-[10px] font-bold mt-0.5 ${c.text}`}>{jobsPct.toFixed(0)}%</p>
              </div>
            )
          })()}

          {/* To-go callout */}
          {toGo > 0 && revTarget > 0 && (
            <div className="bg-slate-50 rounded-xl px-3 py-2 border border-slate-100">
              <p className="text-xs text-slate-500 leading-snug">
                <span className="font-black text-slate-800">{fmt$$(toGo)} to go</span>
                {' '}to hit your {periodLabel || 'monthly'} revenue target
              </p>
            </div>
          )}
          {toGo === 0 && revPct !== null && revPct >= 100 && (
            <div className="bg-emerald-50 rounded-xl px-3 py-2 border border-emerald-100">
              <p className="text-xs text-emerald-700 font-black leading-snug">
                🎯 Revenue goal hit! Great work this period.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
