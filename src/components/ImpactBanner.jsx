import { useState, useEffect } from 'react'
import { Sparkles, ShieldCheck, TrendingUp, Users } from 'lucide-react'
import { api, USE_API } from '@/lib/api'
import { fmt$$, fmtN, cn } from '@/lib/utils'

// Agency-side labels for the honest win categories the ledger groups by. Mirrors
// CATEGORY_META in api/lib/impactLedger.js, kept local so this component pulls in
// no server import; a category the ledger never emits simply never renders.
const CATEGORY_LABEL = {
  recovery:      'Recovered',
  reallocation:  'Budget shifts',
  pacing_save:   'Pacing saves',
  early_warning: 'Early warnings',
}

// Unit → the noun that follows a non-dollar headline figure (singular/plural aware).
// 'count' (and any other unit) collapses to the generic "measurable win(s)".
function unitCaption(unit, value) {
  const one = value === 1
  if (unit === 'leads') return one ? 'lead recovered' : 'leads recovered'
  if (unit === 'jobs')  return one ? 'job protected'  : 'jobs protected'
  return one ? 'measurable win' : 'measurable wins'
}

/**
 * ImpactBanner — the agency hero that makes the intelligence layer's INFLUENCE
 * visible: the honest, weighted tally of what the system actually moved (the
 * intel-v12 influence ledger). Self-fetches the PORTFOLIO ledger
 * (api.getImpactLedger() with no clientId) and renders a single-unit headline —
 * never a cross-unit sum — the agency narration, and the named clients behind it.
 *
 * HONEST BY CONSTRUCTION. The figure is the ledger's own headline: for a dollars
 * headline it leads with the RISK-ADJUSTED weighted value (Σ value × confidence),
 * not the gross; `proven` is EARNED (≥3 events AND ≥0.6 headline confidence), so
 * the badge reflects a real track record, never volume. The count / client_count
 * are unit-agnostic event tallies (safe to show); a client's value is never summed
 * across units, so each contributor chip shows only its event count.
 *
 * THEME-INDEPENDENT. It mounts on BOTH the light Intelligence page and the dark
 * ExecView, so it brings its OWN brand-gradient background rather than inheriting
 * either page's theme. It stays completely SILENT (renders null) until there is a
 * non-empty, meaningful headline — no "$0 delivered" hero on a fresh portfolio.
 *
 * AGENCY-ONLY surface. Both mount points are agency views, so the full ledger
 * (dollars + per-client attribution + agency narration) is appropriate here. The
 * client-facing wins line is a separate, deliberately vague seam (intel-v12 B4).
 *
 * @param {{className?: string}} props  optional outer-margin tuning per mount.
 */
export default function ImpactBanner({ className = '' }) {
  const [data, setData]     = useState(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!USE_API) return
    let alive = true
    api.getImpactLedger()              // no clientId → portfolio scope (the agency hero)
      .then(d => { if (alive) { setData(d); setLoaded(true) } })
      .catch(() => { if (alive) setLoaded(true) })
    return () => { alive = false }
  }, [])

  // Silent until we have a real, non-empty headline — no empty/zero hero.
  if (!USE_API || !loaded || !data) return null
  const h = data.headline
  if (!h || !data.count) return null

  const isDollars   = h.unit === 'dollars'
  const figureValue = isDollars ? Math.round(h.weighted) : Math.round(h.value)
  if (!(figureValue > 0)) return null   // never trumpet a $0 risk-adjusted hero

  const bigNumber = isDollars ? fmt$$(h.weighted) : fmtN(h.value)
  const caption   = isDollars ? 'protected in client goals' : unitCaption(h.unit, h.value)
  const showGross = isDollars && Math.round(h.value) !== figureValue   // confidence < 1
  const proven    = !!data.proven

  // Honest sub-stats — unit-agnostic counts + the ledger's own avg confidence.
  const stats = [
    `${fmtN(data.count)} ${data.count === 1 ? 'win' : 'wins'}`,
    data.client_count > 1 ? `across ${fmtN(data.client_count)} clients` : null,
    data.confidence != null ? `${Math.round(data.confidence * 100)}% avg confidence` : null,
  ].filter(Boolean)

  // Top NAMED contributors (already rank-sorted by the ledger). Counts only — a
  // client's value is never summed across units, so we never show a dollar here.
  const contributors = (Array.isArray(data.ledger?.by_client) ? data.ledger.by_client : [])
    .filter(c => c && c.client_name)
    .slice(0, 4)

  // Category texture (subtle footer) — labels + honest per-category event counts.
  const cats = (Array.isArray(data.categories) ? data.categories : [])
    .map(k => ({ key: k, label: CATEGORY_LABEL[k], count: data.ledger?.by_category?.[k]?.count }))
    .filter(c => c.label)

  return (
    <div className={cn(
      'relative overflow-hidden rounded-2xl bg-gradient-to-br from-brand-600 to-brand-700 text-white shadow-sm',
      className,
    )}>
      {/* decorative wash — purely ornamental, never interactive */}
      <Sparkles className="pointer-events-none absolute -top-8 -right-8 h-40 w-40 rotate-12 text-white/10" aria-hidden="true" />

      <div className="relative px-6 py-5 sm:px-7 sm:py-6">
        {/* eyebrow + track-record badge */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-[11px] font-black uppercase tracking-wider text-white/80">
            <Sparkles className="h-3.5 w-3.5" />
            What intelligence delivered
          </div>
          <span className={cn(
            'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-black uppercase tracking-wide ring-1',
            proven ? 'bg-white/20 ring-white/30' : 'bg-white/10 ring-white/20',
          )}>
            {proven ? <ShieldCheck className="h-3 w-3" /> : <TrendingUp className="h-3 w-3" />}
            {proven ? 'Proven track record' : 'Building track record'}
          </span>
        </div>

        {/* headline figure */}
        <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-4xl font-black tracking-tight tabular-nums sm:text-5xl">{bigNumber}</span>
          <span className="text-sm font-bold text-white/85">{caption}</span>
        </div>
        {showGross && (
          <p className="mt-0.5 text-xs font-semibold text-white/60">
            risk-adjusted · {fmt$$(h.value)} identified
          </p>
        )}

        {/* agency narration */}
        {typeof data.narration === 'string' && data.narration && (
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-white/85">{data.narration}</p>
        )}

        {/* honest sub-stats */}
        {stats.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-semibold text-white/70">
            {stats.map((s, i) => (
              <span key={i} className="flex items-center gap-2">
                {i > 0 && <span className="text-white/30">·</span>}
                <span>{s}</span>
              </span>
            ))}
          </div>
        )}

        {/* top named contributors */}
        {contributors.length > 1 && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-[11px] font-black uppercase tracking-wide text-white/70">
              <Users className="h-3.5 w-3.5" /> Top contributors
            </span>
            {contributors.map(c => (
              <span
                key={c.client_id || c.client_name}
                title={c.primary_unit ? `primary unit: ${c.primary_unit}` : undefined}
                className="inline-flex items-center gap-1.5 rounded-lg bg-white/10 px-2.5 py-1 text-xs"
              >
                <span className="max-w-[11rem] truncate font-bold">{c.client_name}</span>
                <span className="text-white/60">· {fmtN(c.count)}</span>
              </span>
            ))}
          </div>
        )}

        {/* category texture */}
        {cats.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] font-bold uppercase tracking-wide text-white/55">
            {cats.map(c => (
              <span key={c.key}>
                {c.label}{Number.isFinite(c.count) ? ` · ${fmtN(c.count)}` : ''}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
