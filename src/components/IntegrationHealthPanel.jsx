import { useEffect, useState } from 'react'
import { Plug, ShieldAlert, Inbox, Activity, Wrench } from 'lucide-react'
import { api, USE_API } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * IntegrationHealthPanel — the cli_framework → dashboard "Integration Health" tile.
 *
 * A SEPARATE toolkit (cli_framework) operates the multi-tenant CRM/field-service
 * integrations and PUSHES a per-tenant integration-health snapshot into this
 * dashboard (POST /api/integration-health, machine/shared-secret gated). This panel
 * self-fetches the stored roster back (api.getIntegrationHealth() → GET
 * /api/integration-health) and renders it for agency operators: per tenant, a
 * tone-mapped health badge, the audit finding counts, open dead-letters, the vendors
 * whose circuit-breakers are tripped, and when the tenant was last active.
 *
 * INERT BY CONSTRUCTION. The dashboard never calls cli_framework; this is a passive
 * mirror. Until a push lands the table is empty and the panel renders a calm
 * empty-state ("No integration-health data yet"), never an error.
 *
 * AGENCY-ONLY. The read describes another tool's tenants + integration internals, so
 * (like OpsHealthStrip's /ops read) it 403s a client token and is mounted only on the
 * agency Intelligence page. USE_API-gated so it is absent in the demo build, and it
 * SWALLOWS any read error (renders the empty-state) so a fault never breaks the page.
 */

// Tone per health grade — worst (critical) → best (ok). Soft pill bg + ring + text,
// matching the OpsHealthStrip palette family.
const TONE = {
  critical: { bg: 'bg-rose-50',    ring: 'ring-rose-200',    text: 'text-rose-700',    dot: 'bg-rose-500',    label: 'Critical' },
  degraded: { bg: 'bg-amber-50',   ring: 'ring-amber-200',   text: 'text-amber-700',   dot: 'bg-amber-500',   label: 'Degraded' },
  watch:    { bg: 'bg-sky-50',     ring: 'ring-sky-200',     text: 'text-sky-700',     dot: 'bg-sky-500',     label: 'Watch'    },
  ok:       { bg: 'bg-emerald-50', ring: 'ring-emerald-200', text: 'text-emerald-700', dot: 'bg-emerald-500', label: 'OK'       },
}

// The fixed SAFE allow-list of operator actions, mirrored from the backend
// (routes/remediationRequests.js → ALLOWED_ACTIONS). NO vendor-write exists here.
// `needsVendor` actions carry a {vendor} param; clear_breaker prefers a tripped
// breaker's vendor, else prompts. Order = the affordance's button order.
const ACTIONS = [
  { key: 'reaudit',       label: 'Re-audit'      },
  { key: 'clear_breaker', label: 'Clear breaker', needsVendor: true },
  { key: 'rebuild_index', label: 'Rebuild index' },
  { key: 'export_queue',  label: 'Export queue'  },
]

// Tone per request status — pending/claimed are in-flight, done is a win, failed is bad.
const REQ_TONE = {
  pending: { bg: 'bg-slate-50',   ring: 'ring-slate-200',   text: 'text-slate-600'  },
  claimed: { bg: 'bg-sky-50',     ring: 'ring-sky-200',     text: 'text-sky-700'    },
  done:    { bg: 'bg-emerald-50', ring: 'ring-emerald-200', text: 'text-emerald-700' },
  failed:  { bg: 'bg-rose-50',    ring: 'ring-rose-200',    text: 'text-rose-700'   },
}

const ACTION_LABEL = ACTIONS.reduce((m, a) => { m[a.key] = a.label; return m }, {})

function RequestBadge({ req }) {
  const t = REQ_TONE[req.status] || REQ_TONE.pending
  return (
    <span
      className={cn('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold ring-1', t.bg, t.ring, t.text)}
      title={`${ACTION_LABEL[req.action] || req.action} — ${req.status}`}
    >
      {ACTION_LABEL[req.action] || req.action}
      <span className="opacity-60">· {req.status}</span>
    </span>
  )
}

// Compact, null-safe "X ago" for a last-activity timestamp.
function ago(iso) {
  if (!iso) return null
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return null
  const s = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  return `${d}d ago`
}

function HealthBadge({ health }) {
  const t = TONE[health] || TONE.watch
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-lg px-2 py-0.5 text-[11px] font-semibold ring-1', t.bg, t.ring, t.text)}>
      <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', t.dot)} aria-hidden="true" />
      {t.label}
    </span>
  )
}

function TenantRow({ t, requests, onAction, busy }) {
  const audit = t.audit || {}
  const findings = (Number(audit.critical) || 0) + (Number(audit.high) || 0)
                 + (Number(audit.medium) || 0) + (Number(audit.low) || 0)
  const breakers = Array.isArray(t.breakers_tripped) ? t.breakers_tripped : []
  const last = ago(t.last_activity)
  const reqs = Array.isArray(requests) ? requests : []

  // clear_breaker needs a vendor: prefer this tenant's first tripped-breaker
  // vendor (the obvious target shown right above), else prompt the operator.
  function resolveVendor() {
    const fromBreaker = breakers.find(b => b && b.vendor) ?.vendor
    if (fromBreaker) return fromBreaker
    if (typeof window === 'undefined' || !window.prompt) return null
    const v = window.prompt(`Clear breaker for ${t.tenant_id} — vendor?`)
    return (v && v.trim()) ? v.trim() : null
  }

  function handle(action) {
    if (busy) return
    let params
    if (action.needsVendor) {
      const vendor = resolveVendor()
      if (!vendor) return            // operator cancelled / no vendor → no request
      params = { vendor }
    }
    onAction(t.tenant_id, action.key, params)
  }

  return (
    <div className="rounded-xl border border-slate-100 bg-white px-3 py-2.5">
      <div className="flex items-start gap-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-slate-700 text-sm truncate">{t.tenant_id}</span>
            <HealthBadge health={t.health} />
          </div>
          <div className="mt-1.5 flex items-center gap-3 flex-wrap text-[10px] font-semibold text-slate-400">
            {findings > 0 ? (
              <span className="inline-flex items-center gap-1" title="audit findings (critical / high / medium / low)">
                <ShieldAlert className="w-3 h-3 shrink-0" aria-hidden="true" />
                {(Number(audit.critical) || 0)}C · {(Number(audit.high) || 0)}H · {(Number(audit.medium) || 0)}M · {(Number(audit.low) || 0)}L
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-slate-300">
                <ShieldAlert className="w-3 h-3 shrink-0" aria-hidden="true" />
                no audit findings
              </span>
            )}
            {Number(t.dead_letters_open) > 0 && (
              <span className="inline-flex items-center gap-1 text-amber-600" title="open dead-letters">
                <Inbox className="w-3 h-3 shrink-0" aria-hidden="true" />
                {t.dead_letters_open} dead-letter{Number(t.dead_letters_open) === 1 ? '' : 's'}
              </span>
            )}
            {last && (
              <span className="inline-flex items-center gap-1" title="last integration activity">
                <Activity className="w-3 h-3 shrink-0" aria-hidden="true" />
                {last}
              </span>
            )}
          </div>
          {breakers.length > 0 && (
            <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
              {breakers.map((b, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 rounded-md bg-rose-50 ring-1 ring-rose-200 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700"
                  title={b && b.reason ? b.reason : 'breaker tripped'}
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-rose-500 shrink-0" aria-hidden="true" />
                  {b && b.vendor ? b.vendor : 'vendor'}
                </span>
              ))}
            </div>
          )}

          {/* Operator actions — request a SAFE cli operation on this tenant. The
              dashboard only records the request (status 'pending'); cli pulls +
              executes + reports back. Allow-list only; NO vendor-write here. */}
          {onAction && (
            <div className="mt-2 flex items-center gap-1 flex-wrap">
              <Wrench className="w-3 h-3 text-slate-300 shrink-0" aria-hidden="true" />
              {ACTIONS.map((a) => (
                <button
                  key={a.key}
                  type="button"
                  disabled={busy}
                  onClick={() => handle(a)}
                  className="rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {a.label}
                </button>
              ))}
            </div>
          )}

          {reqs.length > 0 && (
            <div className="mt-1.5 flex items-center gap-1 flex-wrap">
              {reqs.map((r) => <RequestBadge key={r.id} req={r} />)}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default function IntegrationHealthPanel() {
  const [data, setData]         = useState(null)
  const [loaded, setLoaded]     = useState(false)
  const [requests, setRequests] = useState([])
  const [busy, setBusy]         = useState(false)

  // Pull the recent remediation requests so the tile can show each tenant's
  // pending/claimed/done/failed status. Swallow errors (the queue is a passive
  // affordance — a fault here must never break the health read).
  function refreshRequests() {
    if (!USE_API) return
    api.listRemediationRequests()
      .then((d) => setRequests(Array.isArray(d && d.requests) ? d.requests : []))
      .catch(() => { /* leave the prior list; the tile degrades gracefully */ })
  }

  useEffect(() => {
    if (!USE_API) return undefined
    let alive = true
    api.getIntegrationHealth()
      .then((d) => { if (alive) { setData(d); setLoaded(true) } })
      .catch(() => { if (alive) setLoaded(true) })
    api.listRemediationRequests()
      .then((d) => { if (alive) setRequests(Array.isArray(d && d.requests) ? d.requests : []) })
      .catch(() => { /* INERT until an operator requests one */ })
    return () => { alive = false }
  }, [])

  // Operator clicked an action on a tenant → record the request, then refresh the
  // per-tenant status row. The dashboard never executes; cli pulls + reports back.
  function submitAction(tenantId, action, params) {
    if (busy) return
    setBusy(true)
    api.createRemediationRequest({ client_id: tenantId, action, ...(params ? { params } : {}) })
      .then(() => refreshRequests())
      .catch(() => { /* a rejected (e.g. out-of-allow-list) request is a no-op here */ })
      .finally(() => setBusy(false))
  }

  // Absent in the demo build (no API) and while the first read is in flight.
  if (!USE_API || !loaded) return null

  const tenants = (data && Array.isArray(data.tenants)) ? data.tenants : []
  const summary = (data && data.summary) || {}
  const by      = summary.by_health || {}

  // Group the most recent requests per tenant (newest-first from the API), capping
  // each tenant's strip so a busy tenant doesn't flood its row.
  const byTenant = {}
  for (const r of requests) {
    if (!r || !r.client_id) continue
    if (!byTenant[r.client_id]) byTenant[r.client_id] = []
    if (byTenant[r.client_id].length < 4) byTenant[r.client_id].push(r)
  }

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm">
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4 pb-3 border-b border-slate-50">
        <div className="w-8 h-8 rounded-xl bg-brand-50 flex items-center justify-center shrink-0">
          <Plug className="w-4 h-4 text-brand-500" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <h3 className="font-semibold text-slate-800 text-sm">Integration Health</h3>
          <p className="text-[11px] text-slate-400">Per-tenant integration status from the CLI toolkit</p>
        </div>
        {tenants.length > 0 && (
          <div className="ml-auto flex items-center gap-1.5 flex-wrap text-[10px] font-semibold">
            {(Number(by.critical) || 0) > 0 && <span className="rounded-md bg-rose-50 ring-1 ring-rose-200 px-1.5 py-0.5 text-rose-700">{by.critical} critical</span>}
            {(Number(by.degraded) || 0) > 0 && <span className="rounded-md bg-amber-50 ring-1 ring-amber-200 px-1.5 py-0.5 text-amber-700">{by.degraded} degraded</span>}
            {(Number(by.watch) || 0) > 0 && <span className="rounded-md bg-sky-50 ring-1 ring-sky-200 px-1.5 py-0.5 text-sky-700">{by.watch} watch</span>}
            {(Number(by.ok) || 0) > 0 && <span className="rounded-md bg-emerald-50 ring-1 ring-emerald-200 px-1.5 py-0.5 text-emerald-700">{by.ok} ok</span>}
          </div>
        )}
      </div>

      <div className="px-4 py-4">
        {tenants.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <div className="w-10 h-10 rounded-2xl bg-slate-50 flex items-center justify-center">
              <Plug className="w-5 h-5 text-slate-300" aria-hidden="true" />
            </div>
            <p className="text-sm font-medium text-slate-500">No integration-health data yet</p>
            <p className="text-[11px] text-slate-400 max-w-xs">
              The CLI toolkit hasn&apos;t pushed a snapshot yet. Once it does, each tenant&apos;s
              integration status appears here.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {tenants.map((t) => (
              <TenantRow
                key={t.tenant_id}
                t={t}
                requests={byTenant[t.tenant_id]}
                onAction={submitAction}
                busy={busy}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
