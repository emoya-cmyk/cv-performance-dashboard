import { ShieldCheck, Activity, AlertTriangle, Wrench } from 'lucide-react'
import { USE_API } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useOpsHealth } from '@/lib/useOpsHealth'

/**
 * OpsHealthStrip — the AUTONOMY-LIVENESS proof line (ops-v1). The thin, honest
 * reassurance that the self-healing engine behind every panel below is actually
 * RUNNING on-cadence, not silently dead. Self-fetches the job_heartbeats ledger
 * grade (api.getOpsHealth() → GET /api/insights/ops) and renders ONE tone-mapped
 * pill: the overall status, when the engine last did anything, how many job-classes
 * are on cadence, and the self-heals it has quietly performed this week.
 *
 * WHY IT MATTERS. Before this, a stopped scheduler looked identical to a healthy idle
 * one — there was no persisted record that the autonomous loop had fired. This strip is
 * the company-facing answer to "is the machine actually working unattended?": green +
 * pulsing when live, amber when slipping, rose when stalled, sky when warming up.
 *
 * HONEST BY CONSTRUCTION. Tone follows the server's own alarm precedence (assessOps),
 * never a guess. A fresh install with nothing run yet grades 'warming' (cold-start
 * honest, NOT an outage), and we suppress the "0/N on cadence" fact so a cold start
 * reads calmly. `never` is never rendered as "down" — only overdue/stale are.
 *
 * AGENCY-ONLY. The /ops read describes the INTERNAL scheduler — no client identifiers —
 * and 403s a client token (like getConnectionHealth). It is mounted only on the agency
 * Intelligence page, never on a client surface. USE_API-gated so it is absent in the
 * demo build, and it SWALLOWS any read error (renders null) so a ledger fault hides the
 * badge rather than breaking the page.
 *
 * @param {{className?: string}} props  optional outer-margin tuning per mount.
 */

// Tone per overall ops status — mirrors assessOps' precedence (stale ▸ overdue ▸ live
// ▸ warming). Each carries the soft pill background, ring, text, leading icon, and
// whether the live-dot pulses (alive states pulse; a stalled engine holds steady).
const TONE = {
  live:    { dot: 'bg-emerald-400', ring: 'ring-emerald-200', bg: 'bg-emerald-50', text: 'text-emerald-700', Icon: ShieldCheck,   label: 'Live',         pulse: true  },
  overdue: { dot: 'bg-amber-400',   ring: 'ring-amber-200',   bg: 'bg-amber-50',   text: 'text-amber-700',   Icon: Activity,      label: 'Running late', pulse: true  },
  stale:   { dot: 'bg-rose-400',    ring: 'ring-rose-200',    bg: 'bg-rose-50',    text: 'text-rose-700',    Icon: AlertTriangle, label: 'Degraded',     pulse: false },
  warming: { dot: 'bg-sky-400',     ring: 'ring-sky-200',     bg: 'bg-sky-50',     text: 'text-sky-700',     Icon: Activity,      label: 'Warming up',   pulse: true  },
}

// Compact, honest "X ago" for the freshest heartbeat. Null-safe — a missing age
// simply drops the fact rather than rendering "NaN ago".
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

export default function OpsHealthStrip({ className = '' }) {
  // Shared live-read: byte-identical first fetch + a low-cadence poll so the
  // freshness fact below stays honest on a long-open tab (see lib/useOpsHealth).
  const { data, loaded } = useOpsHealth()

  if (!USE_API || !loaded || !data || !data.status) return null
  const tone    = TONE[data.status] || TONE.warming
  const Icon    = tone.Icon
  const warming = data.status === 'warming'

  // "the engine last did something X ago" = the freshest heartbeat across all
  // job-classes (the watchdog's 15-min cadence usually leads). A live engine shows
  // a small number here; a stalled one shows hours/days, corroborating the tone.
  const ages = (Array.isArray(data.jobs) ? data.jobs : [])
    .map(j => (j && Number.isFinite(j.ageMs)) ? j.ageMs : null)
    .filter(v => v != null)
  const lastBeat = ago(ages.length ? Math.min(...ages) : null)

  const total     = Number.isFinite(data.total)         ? data.total         : (Array.isArray(data.jobs) ? data.jobs.length : 0)
  const onCadence = Number.isFinite(data.liveCount)     ? data.liveCount     : 0
  const heals     = Number.isFinite(data.healsRecent)   ? data.healsRecent   : 0
  const degraded  = Number.isFinite(data.degradedCount) ? data.degradedCount : 0

  // Honest sub-facts. While warming (fresh install, nothing has run yet) we suppress
  // the "0/N on cadence" so a cold start never reads as an outage. Self-heals (the
  // visible self-correction count) lead in emerald; any error-flagged job in amber.
  const facts = [
    lastBeat     ? { text: `last run ${lastBeat}`,                         tone: 'text-slate-400'  } : null,
    !warming     ? { text: `${onCadence}/${total} on cadence`,             tone: 'text-slate-400'  } : null,
    heals > 0    ? { text: `${heals} self-heal${heals === 1 ? '' : 's'}`,  tone: 'text-emerald-600', icon: Wrench } : null,
    degraded > 0 ? { text: `${degraded} flagged`,                          tone: 'text-amber-600'  } : null,
  ].filter(Boolean)

  return (
    <div className={cn('flex', className)}>
      <span
        className={cn('inline-flex items-center gap-2 rounded-xl px-3 py-1.5 text-[11px] font-semibold ring-1', tone.bg, tone.ring, tone.text)}
        title={data.headline || undefined}
        role="status"
        aria-live="polite"
      >
        <span className={cn('w-2 h-2 rounded-full shrink-0', tone.dot, tone.pulse && 'animate-pulse')} aria-hidden="true" />
        <Icon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        <span className="uppercase tracking-wide">Autonomy · {tone.label}</span>
        {facts.map((f, i) => {
          const FactIcon = f.icon
          return (
            <span key={i} className={cn('inline-flex items-center gap-1 font-medium normal-case tracking-normal', f.tone)}>
              <span className="text-slate-300" aria-hidden="true">·</span>
              {FactIcon ? <FactIcon className="w-3 h-3 shrink-0" aria-hidden="true" /> : null}
              {f.text}
            </span>
          )
        })}
      </span>
    </div>
  )
}
