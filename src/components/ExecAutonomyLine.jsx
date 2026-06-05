import { useState, useEffect } from 'react'
import { ShieldCheck, Activity, AlertTriangle, Wrench } from 'lucide-react'
import { api, USE_API } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * ExecAutonomyLine — the EXEC-FACING confidence proof (ops-v2). It reads the exact
 * same live ledger grade as the agency OpsHealthStrip (api.getOpsHealth() → GET
 * /api/insights/ops), but re-tones and re-skins it for the boardroom. Where the
 * agency strip speaks ops ("4/4 on cadence · 3 self-heals"), this answers the one
 * question an executive actually has: "can I trust that this keeps running on its
 * own, and that the numbers I'm looking at are current?"
 *
 * It sits on the dark ExecView beside the ImpactBanner, and the two read as a pair:
 * the banner shows what the autonomous analyst MOVED; this shows that the analyst is
 * still ON — verified minutes ago and quietly self-correcting with no one watching.
 * The self-correction count is the hero fact: hard proof the system fixes itself.
 *
 * SHARED CONTRACT WITH OpsHealthStrip — identical fetch + null-safety, deliberately:
 *   • USE_API-gated, so it is simply absent from the demo build (renders null).
 *   • SWALLOWS any read error → null, so a ledger fault hides the line, never breaks
 *     the exec view.
 *   • Honest 'warming' cold-start: on a fresh install nothing has run yet, so we keep
 *     the calm "Starting up" tone and the freshness fact and never imply an outage.
 * The /ops read describes the INTERNAL scheduler only — no client identifiers — and
 * 403s a client token (proven at the API layer, like getConnectionHealth). ExecView
 * is an agency surface, so this is in-bounds exactly as the strip is on Intelligence;
 * under a client token the 403 is swallowed and the line simply doesn't appear. It
 * therefore adds NO new client-data surface — it self-fetches a separate agency-scoped
 * endpoint that carries no per-client payload.
 *
 * @param {{className?: string}} props  optional outer-margin tuning per mount.
 */

// Exec-toned status map (vs the agency strip's ops vocabulary), on a dark-canvas
// palette to sit over ExecView's near-black background. Labels speak reassurance, not
// job-scheduler state; the live dot pulses while the engine is alive and holds steady
// once it has genuinely stalled — mirroring assessOps' own alarm precedence.
const TONE = {
  live:    { dot: 'bg-emerald-400', text: 'text-emerald-300', Icon: ShieldCheck,   label: 'Always-on',   pulse: true  },
  overdue: { dot: 'bg-amber-400',   text: 'text-amber-300',   Icon: Activity,      label: 'Catching up', pulse: true  },
  stale:   { dot: 'bg-rose-400',    text: 'text-rose-300',    Icon: AlertTriangle, label: 'Recovering',  pulse: false },
  warming: { dot: 'bg-sky-400',     text: 'text-sky-300',     Icon: Activity,      label: 'Starting up', pulse: true  },
}

// Compact, honest "X ago" for the freshest heartbeat. Null-safe — a missing age drops
// the fact rather than rendering "NaN ago".
function ago(ms) {
  if (ms == null || !Number.isFinite(ms)) return null
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  return `${d}d ago`
}

export default function ExecAutonomyLine({ className = '' }) {
  const [data, setData]     = useState(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!USE_API) return
    let alive = true
    api.getOpsHealth()
      .then(d => { if (alive) { setData(d); setLoaded(true) } })
      .catch(() => { if (alive) setLoaded(true) })   // swallow — hide the line, never break the page
    return () => { alive = false }
  }, [])

  if (!USE_API || !loaded || !data || !data.status) return null
  const tone    = TONE[data.status] || TONE.warming
  const Icon    = tone.Icon
  const warming = data.status === 'warming'

  // "verified X ago" = the freshest heartbeat across all job-classes (the watchdog's
  // 15-min cadence usually leads). A live engine shows a small number; a stalled one
  // shows hours/days, corroborating the tone. This freshness — not a job fraction — is
  // the continuity proof an exec reads intuitively.
  const ages = (Array.isArray(data.jobs) ? data.jobs : [])
    .map(j => (j && Number.isFinite(j.ageMs)) ? j.ageMs : null)
    .filter(v => v != null)
  const lastBeat = ago(ages.length ? Math.min(...ages) : null)

  const heals    = Number.isFinite(data.healsRecent)   ? data.healsRecent   : 0
  const degraded = Number.isFinite(data.degradedCount) ? data.degradedCount : 0

  // Exec-toned facts, plain English — no scheduler jargon. While warming we keep just
  // the freshness so a cold start reads calmly. The self-correction tally leads in
  // emerald (the proof the system heals itself); anything flagged trails in amber.
  const facts = [
    lastBeat     ? { text: `verified ${lastBeat}`,                                            tone: 'text-white/45' } : null,
    !warming && heals > 0 ? { text: `${heals} issue${heals === 1 ? '' : 's'} auto-resolved this week`, tone: 'text-emerald-300/90', icon: Wrench } : null,
    !warming && degraded > 0 ? { text: `${degraded} flagged for review`,                      tone: 'text-amber-300/90' } : null,
  ].filter(Boolean)

  return (
    <div className={cn('flex', className)}>
      <span
        className="inline-flex items-center gap-2.5 rounded-full bg-white/5 px-4 py-2 ring-1 ring-white/10 backdrop-blur"
        title={data.headline || undefined}
        role="status"
        aria-live="polite"
      >
        <span className={cn('h-2 w-2 shrink-0 rounded-full', tone.dot, tone.pulse && 'animate-pulse')} aria-hidden="true" />
        <Icon className={cn('h-3.5 w-3.5 shrink-0', tone.text)} aria-hidden="true" />
        <span className={cn('text-[11px] font-black uppercase tracking-widest', tone.text)}>{tone.label}</span>
        {facts.map((f, i) => {
          const FactIcon = f.icon
          return (
            <span key={i} className={cn('inline-flex items-center gap-1.5 text-xs font-semibold', f.tone)}>
              <span className="text-white/20" aria-hidden="true">·</span>
              {FactIcon ? <FactIcon className="h-3 w-3 shrink-0" aria-hidden="true" /> : null}
              {f.text}
            </span>
          )
        })}
      </span>
    </div>
  )
}
