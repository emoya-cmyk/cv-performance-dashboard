// ============================================================
// DriverBreakdown.jsx — the "why" under a Daily Pulse signal.
//
// When a COMPOSITE flow metric (revenue ≡ spend × roas, jobs ≡ leads × close_rate)
// breaks out of a client's own band, the engine (lib/pulseDiagnose, via getClientPulse)
// attaches a `diagnosis` object decomposing that exact same trailing-week move into its
// stored drivers, plus one grounded sentence per audience. This renders it: the sentence,
// then one bar per driver, each sized to its share of the move. A driver that moved
// OPPOSITE the composite carries a NEGATIVE share — drawn in emerald, anchored from the
// right, tagged as a cushion — because it softened the move rather than caused it.
//
// Shared verbatim by the agency surface (Intelligence ▸ Daily pulse, audience="agency")
// and the client surface (/my-dashboard ▸ This Week So Far, audience="client"); the only
// difference between them is the audience-toned tag text and which message string the
// caller binds (diagnosis_message vs diagnosis_client_message). `tone` must carry
// `.accent` (a hex color, drives the bar fill) and `.text` (the Tailwind class for the
// driver %). Renders NOTHING when there's no diagnosis — which is every atomic signal
// (leads, spend) and every degenerate window — so it stays inert on the vast majority of
// rows and lights up only on a clean composite decomposition.
// ============================================================
import { GitBranch } from 'lucide-react'

// Driver display names — mirrors the labels the engine feeds narratePulseDiagnosis,
// so the chips and the grounded sentence above them read identically.
const LBL = { revenue: 'Revenue', jobs: 'Jobs won', leads: 'Leads', spend: 'Ad spend', roas: 'ROAS', close_rate: 'Close rate' }

// One driver line: name · its own % move · a share bar (width ∝ |share| of the composite
// move) · a plain-language tag. A driver with a negative share (it moved against the
// composite) is drawn in emerald, anchored from the right, and tagged as a cushion.
function DriverShareRow({ d, dir, tone, audience, isLead }) {
  const pct      = Number(d.pct)
  const sp       = Number(d.share_pct)
  const held     = Math.abs(pct) < 0.5
  const cushion  = Number(d.share) < 0
  const pctStr   = held ? '0%' : `${pct >= 0 ? '+' : '−'}${Math.abs(Math.round(pct))}%`
  const barW     = held ? 0 : Math.min(Math.abs(sp), 100)
  const barColor = cushion ? '#10b981' : tone.accent
  const pctColor = held ? 'text-slate-400' : cushion ? 'text-emerald-600' : tone.text

  let tag
  if (held) tag = 'held'
  else if (cushion) tag = dir === 'down' ? 'cushioned the drop' : 'tempered the rise'
  else if (audience === 'client') tag = isLead ? 'main driver' : 'also contributed'
  else tag = `${Math.round(sp)}% of the move`

  return (
    <div className="flex items-center gap-2.5">
      <span className="text-[11px] font-bold text-slate-700 w-[4.75rem] shrink-0 truncate">{LBL[d.metric] || d.metric}</span>
      <span className={`text-[11px] font-black tabular-nums w-10 shrink-0 text-right ${pctColor}`}>{pctStr}</span>
      <div className="flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden min-w-[2.5rem]">
        <div
          className="h-full rounded-full"
          style={{ width: `${barW}%`, marginLeft: cushion ? `${100 - barW}%` : 0, background: held ? 'transparent' : barColor, opacity: cushion ? 0.6 : 1 }}
        />
      </div>
      <span className={`text-[10px] font-semibold w-[6.5rem] shrink-0 text-right ${cushion ? 'text-emerald-600' : 'text-slate-400'}`}>{tag}</span>
    </div>
  )
}

export default function DriverBreakdown({ message, diagnosis, tone, audience }) {
  const drivers = Array.isArray(diagnosis?.drivers) ? diagnosis.drivers : []
  if (drivers.length === 0) return null                 // atomic / degenerate signal → no "why" to show
  const dir  = diagnosis.direction === 'down' ? 'down' : 'up'
  const lead = diagnosis.lead
  return (
    <div className="mt-2.5 rounded-xl bg-white border border-slate-100 px-3 py-2.5 shadow-sm">
      <div className="flex items-center gap-1.5 mb-1.5">
        <GitBranch className="w-3 h-3 text-brand-500" />
        <span className="text-[9px] font-black uppercase tracking-widest text-slate-400">Why — what moved it</span>
      </div>
      {message && <p className="text-[11px] text-slate-600 font-medium leading-relaxed mb-2.5">{message}</p>}
      <div className="space-y-1.5">
        {drivers.map((d) => (
          <DriverShareRow key={d.metric} d={d} dir={dir} tone={tone} audience={audience} isLead={d.metric === lead} />
        ))}
      </div>
    </div>
  )
}
