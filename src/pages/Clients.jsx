import { useState, useEffect } from 'react'
import { useOutletContext, useNavigate } from 'react-router-dom'
import { MapPin, TrendingUp, Plus, X, LogOut, Pencil, CheckCircle, AlertCircle, RefreshCw, Trash2 } from 'lucide-react'
import TopBar from '@/components/TopBar'
import { fmt$$, fmtN, fmtPct, fmtX } from '@/lib/utils'
import { api, USE_API } from '@/lib/api'
import { clearToken, isAgency, getUser } from '@/lib/auth'

const INDUSTRIES = [
  'HVAC', 'Plumbing', 'Roofing', 'Electrical', 'Solar',
  'Landscaping', 'Pest Control', 'Painting', 'Flooring', 'Other',
]

const STATUS_STYLE = {
  active: { bg: 'bg-brand-50', text: 'text-brand-600', border: 'border-brand-200' },
  paused: { bg: 'bg-slate-100', text: 'text-slate-500', border: 'border-slate-200' },
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getMondayISO(d = new Date()) {
  const day  = d.getUTCDay()
  const diff = (day === 0 ? -6 : 1) - day
  const m    = new Date(d)
  m.setUTCDate(m.getUTCDate() + diff)
  return m.toISOString().slice(0, 10)
}

const STATUS_OPTS = [
  { value: 'on_track',   label: 'On Track',         Icon: CheckCircle,  active: 'bg-emerald-500 text-white border-emerald-500', idle: 'border-slate-200 text-slate-500 hover:border-emerald-300' },
  { value: 'monitoring', label: 'Monitoring',        Icon: AlertCircle,  active: 'bg-amber-500 text-white border-amber-500',   idle: 'border-slate-200 text-slate-500 hover:border-amber-300'   },
  { value: 'adjusted',   label: 'Strategy Adjusted', Icon: RefreshCw,    active: 'bg-blue-500 text-white border-blue-500',     idle: 'border-slate-200 text-slate-500 hover:border-blue-300'    },
]

// ── Client Update / Goals modal (agency only) ─────────────────────────────────
function ClientUpdateModal({ client, onClose }) {
  const [tab,     setTab]     = useState('update')
  const [loading, setLoading] = useState(true)
  const [saving,  setSaving]  = useState(false)
  const [success, setSuccess] = useState('')
  const [error,   setError]   = useState('')

  const thisMonth = new Date().toISOString().slice(0, 7)  // YYYY-MM
  const thisWeek  = getMondayISO()

  // ── Goals form ──
  const [goals, setGoals] = useState({ revenue_target: '', leads_target: '', jobs_target: '' })
  function setG(k) { return e => setGoals(g => ({ ...g, [k]: e.target.value })) }

  // ── Update form ──
  const [upd, setUpd] = useState({ status: 'on_track', this_week: '', next_week: '', week_start: thisWeek })
  function setU(k) { return e => setUpd(u => ({ ...u, [k]: typeof e === 'string' ? e : e.target.value })) }

  // ── Email digest form ──
  const [email, setEmail]     = useState({ digest_email: '', digest_enabled: false })
  const [emailSaved, setEmailSaved] = useState(false)

  // ── Metrics form ──
  const [metrics, setMetrics] = useState({
    week_start: thisWeek,
    ads_spend: '', ads_clicks: '', ads_impressions: '', ads_leads: '', ads_roas: '',
    lsa_spend: '', lsa_impressions: '', lsa_calls: '', lsa_booked_jobs: '',
    meta_spend: '', meta_impressions: '', meta_clicks: '', meta_leads: '', meta_roas: '',
    gbp_views: '', gbp_searches: '', gbp_calls: '', gbp_directions: '', gbp_website_clicks: '',
    ga4_sessions: '', ga4_new_users: '', ga4_organic_sessions: '', ga4_paid_sessions: '',
    ga4_direct_sessions: '', ga4_conversions: '', ga4_engagement_rate: '',
    raw_leads: '', mql: '', sql_count: '', closed_won: '', projected_revenue: '', avg_ticket: '',
  })
  function setM(k) { return e => setMetrics(m => ({ ...m, [k]: e.target.value })) }

  // Load existing data on open
  useEffect(() => {
    Promise.all([
      api.getGoal(client.id, thisMonth).catch(() => null),
      api.getUpdates(client.id, 1).catch(() => []),
      api.getEmailPrefs(client.id).catch(() => null),
      api.getLatestReport(client.id).catch(() => null),
    ]).then(([goal, updates, emailPrefs, latestReport]) => {
      if (goal) {
        setGoals({
          revenue_target: goal.revenue_target ?? '',
          leads_target:   goal.leads_target   ?? '',
          jobs_target:    goal.jobs_target     ?? '',
        })
      }
      const u = updates?.[0]
      if (u) {
        setUpd({
          status:     u.status     || 'on_track',
          this_week:  u.this_week  || '',
          next_week:  u.next_week  || '',
          week_start: u.week_start ? String(u.week_start).slice(0, 10) : thisWeek,
        })
      }
      if (emailPrefs) {
        setEmail({
          digest_email:   emailPrefs.digest_email   || '',
          digest_enabled: emailPrefs.digest_enabled ?? false,
        })
      }
      if (latestReport) {
        const r = latestReport
        setMetrics(m => ({
          ...m,
          ads_spend:            r.ads_spend            ?? '',
          ads_clicks:           r.ads_clicks           ?? '',
          ads_impressions:      r.ads_impressions      ?? '',
          ads_leads:            r.ads_leads            ?? '',
          ads_roas:             r.ads_roas             ?? '',
          lsa_spend:            r.lsa_spend            ?? '',
          lsa_impressions:      r.lsa_impressions      ?? '',
          lsa_calls:            r.lsa_calls            ?? '',
          lsa_booked_jobs:      r.lsa_booked_jobs      ?? '',
          meta_spend:           r.meta_spend           ?? '',
          meta_impressions:     r.meta_impressions     ?? '',
          meta_clicks:          r.meta_clicks          ?? '',
          meta_leads:           r.meta_leads           ?? '',
          meta_roas:            r.meta_roas            ?? '',
          gbp_views:            r.gbp_views            ?? '',
          gbp_searches:         r.gbp_searches         ?? '',
          gbp_calls:            r.gbp_calls            ?? '',
          gbp_directions:       r.gbp_directions       ?? '',
          gbp_website_clicks:   r.gbp_website_clicks   ?? '',
          ga4_sessions:         r.ga4_sessions         ?? '',
          ga4_new_users:        r.ga4_new_users        ?? '',
          ga4_organic_sessions: r.ga4_organic_sessions ?? '',
          ga4_paid_sessions:    r.ga4_paid_sessions    ?? '',
          ga4_direct_sessions:  r.ga4_direct_sessions  ?? '',
          ga4_conversions:      r.ga4_conversions      ?? '',
          ga4_engagement_rate:  r.ga4_engagement_rate  ?? '',
          raw_leads:            r.raw_leads            ?? '',
          mql:                  r.mql                  ?? '',
          sql_count:            r.sql_count            ?? '',
          closed_won:           r.closed_won           ?? '',
          projected_revenue:    r.projected_revenue    ?? '',
          avg_ticket:           r.avg_ticket           ?? '',
        }))
      }
    }).finally(() => setLoading(false))
  }, [client.id])

  async function handleSaveUpdate(e) {
    e.preventDefault()
    if (!upd.this_week.trim()) { setError("This week's update is required"); return }
    setSaving(true); setError('')
    try {
      await api.saveUpdate(client.id, { ...upd, week_start: upd.week_start || thisWeek })
      setSuccess('Update saved!')
      setTimeout(() => setSuccess(''), 2500)
    } catch (err) {
      setError(err.message)
    } finally { setSaving(false) }
  }

  async function handleSaveGoals(e) {
    e.preventDefault()
    setSaving(true); setError('')
    try {
      await api.saveGoal(client.id, {
        month:          thisMonth + '-01',
        revenue_target: goals.revenue_target !== '' ? Number(goals.revenue_target) : null,
        leads_target:   goals.leads_target   !== '' ? Number(goals.leads_target)   : null,
        jobs_target:    goals.jobs_target    !== '' ? Number(goals.jobs_target)    : null,
      })
      setSuccess('Goals saved!')
      setTimeout(() => setSuccess(''), 2500)
    } catch (err) {
      setError(err.message)
    } finally { setSaving(false) }
  }

  async function handleSaveEmail(e) {
    e.preventDefault()
    setSaving(true); setError('')
    try {
      await api.saveEmailPrefs(client.id, {
        digest_email:   email.digest_email.trim() || null,
        digest_enabled: email.digest_enabled,
      })
      setEmailSaved(true)
      setTimeout(() => setEmailSaved(false), 2500)
    } catch (err) {
      setError(err.message)
    } finally { setSaving(false) }
  }

  async function handleSaveMetrics(e) {
    e.preventDefault()
    if (!metrics.week_start) { setError('Week start is required'); return }
    setSaving(true); setError('')
    const toNum = v => (v === '' || v === null || v === undefined) ? null : Number(v)
    try {
      await api.saveReport(client.id, {
        week_start:           metrics.week_start,
        ads_spend:            toNum(metrics.ads_spend),
        ads_clicks:           toNum(metrics.ads_clicks),
        ads_impressions:      toNum(metrics.ads_impressions),
        ads_leads:            toNum(metrics.ads_leads),
        ads_roas:             toNum(metrics.ads_roas),
        lsa_spend:            toNum(metrics.lsa_spend),
        lsa_impressions:      toNum(metrics.lsa_impressions),
        lsa_calls:            toNum(metrics.lsa_calls),
        lsa_booked_jobs:      toNum(metrics.lsa_booked_jobs),
        meta_spend:           toNum(metrics.meta_spend),
        meta_impressions:     toNum(metrics.meta_impressions),
        meta_clicks:          toNum(metrics.meta_clicks),
        meta_leads:           toNum(metrics.meta_leads),
        meta_roas:            toNum(metrics.meta_roas),
        gbp_views:            toNum(metrics.gbp_views),
        gbp_searches:         toNum(metrics.gbp_searches),
        gbp_calls:            toNum(metrics.gbp_calls),
        gbp_directions:       toNum(metrics.gbp_directions),
        gbp_website_clicks:   toNum(metrics.gbp_website_clicks),
        ga4_sessions:         toNum(metrics.ga4_sessions),
        ga4_new_users:        toNum(metrics.ga4_new_users),
        ga4_organic_sessions: toNum(metrics.ga4_organic_sessions),
        ga4_paid_sessions:    toNum(metrics.ga4_paid_sessions),
        ga4_direct_sessions:  toNum(metrics.ga4_direct_sessions),
        ga4_conversions:      toNum(metrics.ga4_conversions),
        ga4_engagement_rate:  toNum(metrics.ga4_engagement_rate),
        raw_leads:            toNum(metrics.raw_leads),
        mql:                  toNum(metrics.mql),
        sql_count:            toNum(metrics.sql_count),
        closed_won:           toNum(metrics.closed_won),
        projected_revenue:    toNum(metrics.projected_revenue),
        avg_ticket:           toNum(metrics.avg_ticket),
      })
      setSuccess('Metrics saved!')
      setTimeout(() => setSuccess(''), 2500)
    } catch (err) {
      setError(err.message)
    } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl overflow-hidden">

        {/* ── Header ── */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <div>
            <h2 className="text-base font-black text-slate-900">{client.name}</h2>
            <p className="text-xs text-slate-400 mt-0.5">Write weekly update or set monthly goals</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 transition-colors">
            <X className="w-4 h-4 text-slate-500" />
          </button>
        </div>

        {/* ── Tabs ── */}
        <div className="flex border-b border-slate-100 px-6">
          {[
            { key: 'update',  label: "This Week's Update" },
            { key: 'goals',   label: 'Monthly Goals'      },
            { key: 'email',   label: 'Email Digest'       },
            { key: 'metrics', label: 'Weekly Metrics'     },
          ].map(t => (
            <button
              key={t.key}
              onClick={() => { setTab(t.key); setError(''); setSuccess('') }}
              className={`text-xs font-black px-1 py-3 mr-5 border-b-2 transition-colors ${
                tab === t.key
                  ? 'border-brand-500 text-brand-500'
                  : 'border-transparent text-slate-400 hover:text-slate-600'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="p-8 text-center text-slate-400 text-sm">Loading…</div>
        ) : tab === 'email' ? (

          /* ── Email Digest Form ── */
          <form onSubmit={handleSaveEmail} className="p-6 space-y-5">
            <p className="text-xs text-slate-500 bg-slate-50 rounded-xl px-4 py-3 border border-slate-100">
              A performance digest is automatically sent every <strong className="text-slate-800">Monday at 8am</strong> with
              Revenue, Jobs Won, ROAS, and the latest agency update. Requires{' '}
              <code className="text-[11px] bg-slate-100 px-1.5 py-0.5 rounded text-slate-600">RESEND_API_KEY</code> in your API environment.
            </p>

            {/* Toggle */}
            <div className="flex items-center justify-between py-1">
              <div>
                <p className="text-sm font-black text-slate-800">Enable Weekly Digest</p>
                <p className="text-xs text-slate-400 mt-0.5">Send the Monday email to the address below</p>
              </div>
              <button
                type="button"
                onClick={() => setEmail(e => ({ ...e, digest_enabled: !e.digest_enabled }))}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none ${
                  email.digest_enabled ? 'bg-brand-500' : 'bg-slate-200'
                }`}
              >
                <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
                  email.digest_enabled ? 'translate-x-6' : 'translate-x-1'
                }`} />
              </button>
            </div>

            {/* Email address */}
            <div>
              <label className="block text-[10px] font-black uppercase tracking-widest text-slate-500 mb-1.5">
                Send digest to <span className="text-brand-500">*</span>
              </label>
              <input
                type="email"
                value={email.digest_email}
                onChange={e => setEmail(em => ({ ...em, digest_email: e.target.value }))}
                placeholder="client@example.com"
                className="w-full border border-slate-200 rounded-xl px-4 py-2.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
              />
              <p className="text-[10px] text-slate-400 mt-1.5">
                The client will see a branded email with their KPIs and an unsubscribe link.
              </p>
            </div>

            {error      && <p className="text-xs text-rose-500 font-semibold bg-rose-50 rounded-xl px-4 py-2.5 border border-rose-100">{error}</p>}
            {emailSaved && <p className="text-xs text-emerald-600 font-semibold bg-emerald-50 rounded-xl px-4 py-2.5 border border-emerald-100">✓ Email preferences saved!</p>}

            <div className="flex gap-3 pt-1">
              <button type="button" onClick={onClose} className="flex-1 border border-slate-200 text-slate-600 font-semibold text-sm py-2.5 rounded-xl hover:bg-slate-50 transition-colors">
                Close
              </button>
              <button type="submit" disabled={saving} className="flex-1 bg-brand-500 hover:bg-brand-600 text-white font-black text-sm py-2.5 rounded-xl transition-colors disabled:opacity-50">
                {saving ? 'Saving…' : 'Save Preferences →'}
              </button>
            </div>
          </form>

        ) : tab === 'update' ? (

          /* ── Weekly Update Form ── */
          <form onSubmit={handleSaveUpdate} className="p-6 space-y-4">
            {/* Week picker */}
            <div>
              <label className="block text-[10px] font-black uppercase tracking-widest text-slate-500 mb-1.5">Week of</label>
              <input
                type="date"
                value={upd.week_start}
                onChange={setU('week_start')}
                className="w-full border border-slate-200 rounded-xl px-4 py-2.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
              />
            </div>

            {/* Status */}
            <div>
              <label className="block text-[10px] font-black uppercase tracking-widest text-slate-500 mb-2">Campaign Status</label>
              <div className="flex gap-2">
                {STATUS_OPTS.map(opt => {
                  const active = upd.status === opt.value
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setUpd(u => ({ ...u, status: opt.value }))}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-bold transition-all ${active ? opt.active : opt.idle}`}
                    >
                      <opt.Icon className="w-3 h-3" />
                      {opt.label}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* This week */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-[10px] font-black uppercase tracking-widest text-slate-500">
                  What we did this week <span className="text-brand-500">*</span>
                </label>
                <span className={`text-[10px] ${upd.this_week.length > 380 ? 'text-rose-500' : 'text-slate-300'}`}>
                  {upd.this_week.length}/400
                </span>
              </div>
              <textarea
                value={upd.this_week}
                onChange={setU('this_week')}
                maxLength={400}
                rows={4}
                placeholder="Launched two new ad sets targeting homeowners within 25 miles. Google Ads spend was $3.2K this week, generating 47 leads at $68 CPL…"
                className="w-full border border-slate-200 rounded-xl px-4 py-3 text-sm text-slate-900 placeholder-slate-300 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent resize-none leading-relaxed"
              />
            </div>

            {/* Next week */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-[10px] font-black uppercase tracking-widest text-slate-500">Next week's focus</label>
                <span className={`text-[10px] ${upd.next_week.length > 280 ? 'text-rose-500' : 'text-slate-300'}`}>
                  {upd.next_week.length}/300
                </span>
              </div>
              <textarea
                value={upd.next_week}
                onChange={setU('next_week')}
                maxLength={300}
                rows={3}
                placeholder="A/B testing two landing page variants. Increasing LSA budget by $500 to capture seasonal demand…"
                className="w-full border border-slate-200 rounded-xl px-4 py-3 text-sm text-slate-900 placeholder-slate-300 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent resize-none leading-relaxed"
              />
            </div>

            {error   && <p className="text-xs text-rose-500 font-semibold bg-rose-50 rounded-xl px-4 py-2.5 border border-rose-100">{error}</p>}
            {success && <p className="text-xs text-emerald-600 font-semibold bg-emerald-50 rounded-xl px-4 py-2.5 border border-emerald-100">✓ {success}</p>}

            <div className="flex gap-3 pt-1">
              <button type="button" onClick={onClose} className="flex-1 border border-slate-200 text-slate-600 font-semibold text-sm py-2.5 rounded-xl hover:bg-slate-50 transition-colors">
                Close
              </button>
              <button type="submit" disabled={saving} className="flex-1 bg-brand-500 hover:bg-brand-600 text-white font-black text-sm py-2.5 rounded-xl transition-colors disabled:opacity-50">
                {saving ? 'Saving…' : 'Save Update →'}
              </button>
            </div>
          </form>

        ) : tab === 'metrics' ? (

          /* ── Weekly Metrics Form ── */
          <form onSubmit={handleSaveMetrics} className="p-6 flex flex-col gap-4">
            <div>
              <label className="block text-[10px] font-black uppercase tracking-widest text-slate-500 mb-1.5">Week of (Monday)</label>
              <input type="date" value={metrics.week_start} onChange={setM('week_start')}
                className="w-full border border-slate-200 rounded-xl px-4 py-2.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent" />
            </div>

            <div className="max-h-[52vh] overflow-y-auto space-y-5 pr-1">

              {/* Google Ads */}
              <div className="space-y-2">
                <h4 className="text-[10px] font-black uppercase tracking-widest text-slate-400 border-b border-slate-100 pb-1.5">Google Ads</h4>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    ['Spend ($)',    'ads_spend',       '0.00', '0.01'],
                    ['Impressions', 'ads_impressions',  '0',    '1'  ],
                    ['Clicks',      'ads_clicks',       '0',    '1'  ],
                    ['Leads',       'ads_leads',        '0',    '1'  ],
                    ['ROAS (x)',    'ads_roas',         '0.00', '0.01'],
                  ].map(([lbl, key, ph, step]) => (
                    <div key={key}>
                      <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">{lbl}</label>
                      <input type="number" min="0" step={step} value={metrics[key]} onChange={setM(key)} placeholder={ph}
                        className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent" />
                    </div>
                  ))}
                </div>
              </div>

              {/* LSA */}
              <div className="space-y-2">
                <h4 className="text-[10px] font-black uppercase tracking-widest text-slate-400 border-b border-slate-100 pb-1.5">Local Services Ads</h4>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    ['Spend ($)',    'lsa_spend',       '0.00', '0.01'],
                    ['Impressions', 'lsa_impressions',  '0',    '1'  ],
                    ['Calls',       'lsa_calls',        '0',    '1'  ],
                    ['Booked Jobs', 'lsa_booked_jobs',  '0',    '1'  ],
                  ].map(([lbl, key, ph, step]) => (
                    <div key={key}>
                      <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">{lbl}</label>
                      <input type="number" min="0" step={step} value={metrics[key]} onChange={setM(key)} placeholder={ph}
                        className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent" />
                    </div>
                  ))}
                </div>
              </div>

              {/* Meta Ads */}
              <div className="space-y-2">
                <h4 className="text-[10px] font-black uppercase tracking-widest text-slate-400 border-b border-slate-100 pb-1.5">Meta Ads</h4>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    ['Spend ($)',    'meta_spend',       '0.00', '0.01'],
                    ['Impressions', 'meta_impressions',  '0',    '1'  ],
                    ['Clicks',      'meta_clicks',       '0',    '1'  ],
                    ['Leads',       'meta_leads',        '0',    '1'  ],
                    ['ROAS (x)',    'meta_roas',         '0.00', '0.01'],
                  ].map(([lbl, key, ph, step]) => (
                    <div key={key}>
                      <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">{lbl}</label>
                      <input type="number" min="0" step={step} value={metrics[key]} onChange={setM(key)} placeholder={ph}
                        className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent" />
                    </div>
                  ))}
                </div>
              </div>

              {/* GBP */}
              <div className="space-y-2">
                <h4 className="text-[10px] font-black uppercase tracking-widest text-slate-400 border-b border-slate-100 pb-1.5">Google Business Profile</h4>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    ['Views',          'gbp_views',          '0', '1'],
                    ['Searches',       'gbp_searches',       '0', '1'],
                    ['Calls',          'gbp_calls',          '0', '1'],
                    ['Directions',     'gbp_directions',     '0', '1'],
                    ['Website Clicks', 'gbp_website_clicks', '0', '1'],
                  ].map(([lbl, key, ph, step]) => (
                    <div key={key}>
                      <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">{lbl}</label>
                      <input type="number" min="0" step={step} value={metrics[key]} onChange={setM(key)} placeholder={ph}
                        className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent" />
                    </div>
                  ))}
                </div>
              </div>

              {/* GA4 */}
              <div className="space-y-2">
                <h4 className="text-[10px] font-black uppercase tracking-widest text-slate-400 border-b border-slate-100 pb-1.5">GA4 / Web Analytics</h4>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    ['Sessions',      'ga4_sessions',          '0',    '1'   ],
                    ['New Users',     'ga4_new_users',         '0',    '1'   ],
                    ['Organic',       'ga4_organic_sessions',  '0',    '1'   ],
                    ['Paid',          'ga4_paid_sessions',     '0',    '1'   ],
                    ['Direct',        'ga4_direct_sessions',   '0',    '1'   ],
                    ['Conversions',   'ga4_conversions',       '0',    '1'   ],
                    ['Eng. Rate (%)', 'ga4_engagement_rate',   '0.00', '0.01'],
                  ].map(([lbl, key, ph, step]) => (
                    <div key={key}>
                      <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">{lbl}</label>
                      <input type="number" min="0" step={step} value={metrics[key]} onChange={setM(key)} placeholder={ph}
                        className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent" />
                    </div>
                  ))}
                </div>
              </div>

              {/* Pipeline */}
              <div className="space-y-2">
                <h4 className="text-[10px] font-black uppercase tracking-widest text-slate-400 border-b border-slate-100 pb-1.5">Pipeline &amp; Revenue</h4>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    ['Raw Leads',      'raw_leads',         '0',    '1'   ],
                    ['MQL',            'mql',               '0',    '1'   ],
                    ['SQL',            'sql_count',         '0',    '1'   ],
                    ['Closed Won',     'closed_won',        '0',    '1'   ],
                    ['Proj. Rev ($)',  'projected_revenue', '0.00', '0.01'],
                    ['Avg Ticket ($)', 'avg_ticket',        '0.00', '0.01'],
                  ].map(([lbl, key, ph, step]) => (
                    <div key={key}>
                      <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">{lbl}</label>
                      <input type="number" min="0" step={step} value={metrics[key]} onChange={setM(key)} placeholder={ph}
                        className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent" />
                    </div>
                  ))}
                </div>
              </div>

            </div>

            {error   && <p className="text-xs text-rose-500 font-semibold bg-rose-50 rounded-xl px-4 py-2.5 border border-rose-100">{error}</p>}
            {success && <p className="text-xs text-emerald-600 font-semibold bg-emerald-50 rounded-xl px-4 py-2.5 border border-emerald-100">&#x2713; {success}</p>}

            <div className="flex gap-3">
              <button type="button" onClick={onClose} className="flex-1 border border-slate-200 text-slate-600 font-semibold text-sm py-2.5 rounded-xl hover:bg-slate-50 transition-colors">Close</button>
              <button type="submit" disabled={saving} className="flex-1 bg-brand-500 hover:bg-brand-600 text-white font-black text-sm py-2.5 rounded-xl transition-colors disabled:opacity-50">
                {saving ? 'Saving…' : 'Save Metrics →'}
              </button>
            </div>
          </form>

        ) : (

          /* ── Monthly Goals Form ── */
          <form onSubmit={handleSaveGoals} className="p-6 space-y-4">
            <p className="text-xs text-slate-500 bg-slate-50 rounded-xl px-4 py-3 border border-slate-100">
              Setting goals for <strong className="text-slate-800">{new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</strong>.
              These show as progress rings in the client view.
            </p>

            {/* Revenue target */}
            <div>
              <label className="block text-[10px] font-black uppercase tracking-widest text-slate-500 mb-1.5">Revenue Target</label>
              <div className="relative">
                <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-sm font-bold">$</span>
                <input
                  type="number"
                  min="0"
                  step="500"
                  value={goals.revenue_target}
                  onChange={setG('revenue_target')}
                  placeholder="50000"
                  className="w-full border border-slate-200 rounded-xl pl-8 pr-4 py-2.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
                />
              </div>
            </div>

            {/* Leads + Jobs side by side */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[10px] font-black uppercase tracking-widest text-slate-500 mb-1.5">Leads Target</label>
                <input
                  type="number"
                  min="0"
                  value={goals.leads_target}
                  onChange={setG('leads_target')}
                  placeholder="200"
                  className="w-full border border-slate-200 rounded-xl px-4 py-2.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-[10px] font-black uppercase tracking-widest text-slate-500 mb-1.5">Jobs Won Target</label>
                <input
                  type="number"
                  min="0"
                  value={goals.jobs_target}
                  onChange={setG('jobs_target')}
                  placeholder="40"
                  className="w-full border border-slate-200 rounded-xl px-4 py-2.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
                />
              </div>
            </div>

            <p className="text-[10px] text-slate-400">Leave any field blank to hide that metric from the goal ring.</p>

            {error   && <p className="text-xs text-rose-500 font-semibold bg-rose-50 rounded-xl px-4 py-2.5 border border-rose-100">{error}</p>}
            {success && <p className="text-xs text-emerald-600 font-semibold bg-emerald-50 rounded-xl px-4 py-2.5 border border-emerald-100">✓ {success}</p>}

            <div className="flex gap-3 pt-1">
              <button type="button" onClick={onClose} className="flex-1 border border-slate-200 text-slate-600 font-semibold text-sm py-2.5 rounded-xl hover:bg-slate-50 transition-colors">
                Close
              </button>
              <button type="submit" disabled={saving} className="flex-1 bg-brand-500 hover:bg-brand-600 text-white font-black text-sm py-2.5 rounded-xl transition-colors disabled:opacity-50">
                {saving ? 'Saving…' : 'Save Goals →'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

// ── Delete Client confirmation modal ─────────────────────────────────────────
function DeleteClientModal({ client, onClose, onDeleted }) {
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState('')

  async function handleDelete() {
    setLoading(true); setError('')
    try {
      await api.deleteClient(client.id)
      onDeleted(client.id)
      onClose()
    } catch (err) {
      setError(err.message)
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-rose-100 flex items-center justify-center">
              <Trash2 className="w-4 h-4 text-rose-500" />
            </div>
            <h2 className="text-base font-black text-slate-900">Delete Client</h2>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 transition-colors">
            <X className="w-4 h-4 text-slate-500" />
          </button>
        </div>
        <div className="p-6 space-y-4">
          <p className="text-sm text-slate-600">
            Permanently delete <strong className="text-slate-900">{client.name}</strong>? This removes all connections,
            campaigns, goals, weekly updates, and report links for this client. This cannot be undone.
          </p>
          {error && (
            <p className="text-xs text-rose-500 font-semibold bg-rose-50 rounded-xl px-4 py-2.5 border border-rose-100">{error}</p>
          )}
          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 border border-slate-200 text-slate-600 font-semibold text-sm py-2.5 rounded-xl hover:bg-slate-50 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleDelete}
              disabled={loading}
              className="flex-1 bg-rose-500 hover:bg-rose-600 text-white font-black text-sm py-2.5 rounded-xl transition-colors disabled:opacity-50"
            >
              {loading ? 'Deleting…' : 'Delete Client'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Add Client — 4-step onboarding wizard ─────────────────────────────────────
const WIZARD_STEPS = [
  { n: 1, label: 'Business Info'  },
  { n: 2, label: 'Platform IDs'   },
  { n: 3, label: 'Goals'          },
  { n: 4, label: 'Contact Links'  },
]

function AddClientModal({ onClose, onCreated, amOwners = [] }) {
  const [step,    setStep]    = useState(1)
  const [form,    setForm]    = useState({
    name: '', location: '', industry: 'HVAC',
    ghl_location_id: '', hubspot_portal_id: '',
    contact_email: '', calendar_url: '',
    am_owner: '',
    revenue_target: '', leads_target: '', jobs_target: '',
  })
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState('')

  const ic = 'w-full border border-slate-200 rounded-xl px-4 py-2.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent'

  function set(k) { return e => setForm(f => ({ ...f, [k]: e.target.value })) }

  function goNext(e) {
    e.preventDefault()
    if (step === 1 && !form.name.trim()) { setError('Business name is required'); return }
    setError('')
    setStep(s => s + 1)
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const client = await api.createClient(form)
      if (form.revenue_target || form.leads_target || form.jobs_target) {
        const thisMonth = new Date().toISOString().slice(0, 7)
        await api.saveGoal(client.id, {
          month:          thisMonth,
          revenue_target: form.revenue_target ? Number(form.revenue_target) : null,
          leads_target:   form.leads_target   ? Number(form.leads_target)   : null,
          jobs_target:    form.jobs_target     ? Number(form.jobs_target)    : null,
        }).catch(() => {})
      }
      onCreated(client)
      onClose()
    } catch (err) {
      setError(err.message)
    } finally { setLoading(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <div>
            <h2 className="text-base font-black text-slate-900">Add New Client</h2>
            <p className="text-xs text-slate-400 mt-0.5">Step {step} of 4 — {WIZARD_STEPS[step - 1].label}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 transition-colors">
            <X className="w-4 h-4 text-slate-500" />
          </button>
        </div>

        {/* Step indicator */}
        <div className="flex items-center px-6 pt-5 pb-1 gap-0">
          {WIZARD_STEPS.map((s, i) => (
            <div key={s.n} className="flex items-center flex-1">
              <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-black transition-colors shrink-0 ${
                step >= s.n ? 'bg-brand-500 text-white' : 'bg-slate-100 text-slate-400'
              }`}>{s.n}</div>
              {i < 3 && (
                <div className={`flex-1 h-px transition-colors ${step > s.n ? 'bg-brand-500' : 'bg-slate-100'}`} />
              )}
            </div>
          ))}
        </div>

        <form onSubmit={step < 4 ? goNext : handleSubmit} className="p-6 space-y-4">

          {/* ── Step 1: Business Info ── */}
          {step === 1 && (
            <>
              <div>
                <label className="block text-[10px] font-black uppercase tracking-widest text-slate-500 mb-1.5">
                  Business Name <span className="text-brand-500">*</span>
                </label>
                <input
                  value={form.name}
                  onChange={set('name')}
                  className={ic}
                  placeholder="Apex Roofing"
                  autoFocus
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] font-black uppercase tracking-widest text-slate-500 mb-1.5">Industry</label>
                  <select value={form.industry} onChange={set('industry')} className={`${ic} bg-white`}>
                    {INDUSTRIES.map(i => <option key={i}>{i}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] font-black uppercase tracking-widest text-slate-500 mb-1.5">Location</label>
                  <input value={form.location} onChange={set('location')} className={ic} placeholder="Atlanta, GA" />
                </div>
              </div>
              {amOwners.length > 0 && (
                <div>
                  <label className="block text-[10px] font-black uppercase tracking-widest text-slate-500 mb-1.5">Account Manager</label>
                  <select value={form.am_owner} onChange={set('am_owner')} className={`${ic} bg-white`}>
                    <option value="">Unassigned</option>
                    {amOwners.map(am => <option key={am} value={am}>{am}</option>)}
                  </select>
                </div>
              )}
            </>
          )}

          {/* ── Step 2: Platform IDs ── */}
          {step === 2 && (
            <>
              <p className="text-xs text-slate-500 bg-slate-50 rounded-xl px-4 py-3 border border-slate-100">
                Link this client to your GHL sub-account and HubSpot portal. You can skip and add these later from the Connections page.
              </p>
              <div>
                <label className="block text-[10px] font-black uppercase tracking-widest text-slate-500 mb-1.5">
                  GHL Location ID <span className="text-slate-300 normal-case tracking-normal font-normal">(optional)</span>
                </label>
                <input value={form.ghl_location_id} onChange={set('ghl_location_id')} className={`${ic} font-mono`} placeholder="abc123XYZ..." />
                <p className="text-[10px] text-slate-400 mt-1.5">GHL → Settings → API — shown in the URL of each sub-account.</p>
              </div>
              <div>
                <label className="block text-[10px] font-black uppercase tracking-widest text-slate-500 mb-1.5">
                  HubSpot Portal ID <span className="text-slate-300 normal-case tracking-normal font-normal">(optional)</span>
                </label>
                <input value={form.hubspot_portal_id} onChange={set('hubspot_portal_id')} className={`${ic} font-mono`} placeholder="50228146" />
              </div>
            </>
          )}

          {/* ── Step 3: Goals ── */}
          {step === 3 && (
            <>
              <p className="text-xs text-slate-500 bg-slate-50 rounded-xl px-4 py-3 border border-slate-100">
                Set monthly targets for this client. You can update these any time from the client dashboard.
              </p>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-[10px] font-black uppercase tracking-widest text-slate-500 mb-1.5">Revenue</label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">$</span>
                    <input type="number" min="0" value={form.revenue_target} onChange={set('revenue_target')} className={`${ic} pl-6`} placeholder="50000" />
                  </div>
                </div>
                <div>
                  <label className="block text-[10px] font-black uppercase tracking-widest text-slate-500 mb-1.5">Leads</label>
                  <input type="number" min="0" value={form.leads_target} onChange={set('leads_target')} className={ic} placeholder="20" />
                </div>
                <div>
                  <label className="block text-[10px] font-black uppercase tracking-widest text-slate-500 mb-1.5">Jobs</label>
                  <input type="number" min="0" value={form.jobs_target} onChange={set('jobs_target')} className={ic} placeholder="15" />
                </div>
              </div>
            </>
          )}

          {/* ── Step 4: Contact Links ── */}
          {step === 4 && (
            <>
              <p className="text-xs text-slate-500 bg-slate-50 rounded-xl px-4 py-3 border border-slate-100">
                These override the agency-wide defaults on this client's review page and shared report. Leave blank to use agency defaults.
              </p>
              <div>
                <label className="block text-[10px] font-black uppercase tracking-widest text-slate-500 mb-1.5">
                  Contact Email <span className="text-slate-300 normal-case tracking-normal font-normal">(optional)</span>
                </label>
                <input type="email" value={form.contact_email} onChange={set('contact_email')} className={ic} placeholder="you@agency.com" />
              </div>
              <div>
                <label className="block text-[10px] font-black uppercase tracking-widest text-slate-500 mb-1.5">
                  Booking / Calendar URL <span className="text-slate-300 normal-case tracking-normal font-normal">(optional)</span>
                </label>
                <input type="url" value={form.calendar_url} onChange={set('calendar_url')} className={ic} placeholder="https://calendly.com/your-link" />
              </div>
            </>
          )}

          {error && (
            <div className="bg-rose-50 border border-rose-100 rounded-xl px-4 py-2.5">
              <p className="text-xs text-rose-500 font-semibold">{error}</p>
            </div>
          )}

          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={step === 1 ? onClose : () => { setStep(s => s - 1); setError('') }}
              className="flex-1 border border-slate-200 text-slate-600 font-semibold text-sm py-2.5 rounded-xl hover:bg-slate-50 transition-colors"
            >
              {step === 1 ? 'Cancel' : '← Back'}
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 bg-brand-500 hover:bg-brand-600 text-white font-black text-sm py-2.5 rounded-xl transition-colors disabled:opacity-50"
            >
              {loading ? 'Saving…' : step < 4 ? 'Next →' : 'Add Client →'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function Clients() {
  const store = useOutletContext()
  const { clientSummary, refreshClients } = store
  const navigate = useNavigate()
  const [showModal,    setShowModal]    = useState(false)
  const [editClient,   setEditClient]   = useState(null)   // ClientUpdateModal target
  const [deleteTarget, setDeleteTarget] = useState(null)   // DeleteClientModal target
  const [amFilter,     setAmFilter]     = useState('')
  const user = getUser()

  const amOwners = [...new Set(clientSummary.map(c => c.am_owner).filter(Boolean))].sort()
  const filtered = amFilter ? clientSummary.filter(c => c.am_owner === amFilter) : clientSummary

  function handleSignOut() {
    clearToken()
    navigate('/login', { replace: true })
  }

  function handleCreated(newClient) {
    // If the store exposes a refresh, call it; otherwise reload
    if (typeof refreshClients === 'function') refreshClients()
    else window.location.reload()
    // Take user straight to Connections to add credentials
    navigate('/connections')
  }

  function handleDeleted(deletedId) {
    if (typeof refreshClients === 'function') refreshClients()
    else window.location.reload()
  }

  return (
    <div>
      <TopBar
        title="Clients"
        subtitle="Performance snapshot for every active account"
        {...store}
        onClientChange={store.setSelectedClient}
        onPeriodChange={store.setSelectedPeriod}
      />

      {/* Action bar */}
      <div className="flex items-center justify-between mb-5">
        <p className="text-sm text-slate-500">
          <span className="font-black text-slate-900">{filtered.length}</span> active accounts
        </p>
        <div className="flex items-center gap-3">
          {/* AM owner filter */}
          {amOwners.length > 0 && (!USE_API || isAgency()) && (
            <select
              value={amFilter}
              onChange={e => setAmFilter(e.target.value)}
              className="text-xs font-semibold text-slate-600 border border-slate-200 rounded-lg px-2.5 py-1.5 bg-white hover:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200 transition-colors"
            >
              <option value="">All AMs</option>
              {amOwners.map(am => <option key={am} value={am}>{am}</option>)}
            </select>
          )}
          {/* Sign out — always visible */}
          {USE_API && (
            <button
              onClick={handleSignOut}
              className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-700 transition-colors"
            >
              <LogOut className="w-3.5 h-3.5" />
              Sign out {user?.email ? `(${user.email})` : ''}
            </button>
          )}
          {/* Add client — agency only */}
          {(!USE_API || isAgency()) && (
            <button
              onClick={() => setShowModal(true)}
              className="flex items-center gap-2 bg-brand-500 hover:bg-brand-600 text-white font-black text-xs px-4 py-2.5 rounded-xl transition-colors shadow-md shadow-brand-500/20"
            >
              <Plus className="w-3.5 h-3.5" />
              Add Client
            </button>
          )}
        </div>
      </div>

      {/* Client grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {filtered.map(c => {
          const s = STATUS_STYLE[c.status] || STATUS_STYLE.paused
          // ROI and Win rate are derived from the card's own figures so they never read
          // "—" when the summary endpoint omits the pre-aggregated avg_roas / mql_rate.
          // Same revenue/spend and jobs/leads math the client + exec heroes use
          // (e.g. Apex $235,110 / $15,122 → 15.5×). Fall back to any pre-computed field.
          const roi     = c.total_spend > 0 ? c.total_revenue / c.total_spend : (c.avg_roas ?? null)
          const winRate = c.total_leads > 0 ? c.total_closed / c.total_leads  : (c.mql_rate ?? null)
          return (
            <div
              key={c.id}
              className="card p-5 hover:shadow-md transition-all cursor-pointer group border hover:border-brand-200"
              onClick={() => { store.setSelectedClient(c.id); navigate('/') }}
            >
              <div className="flex items-start justify-between mb-4">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="font-black text-slate-900 group-hover:text-brand-500 transition-colors text-sm">
                      {c.name}
                    </h3>
                    <span className={`text-[9px] font-black px-2 py-0.5 rounded-full uppercase tracking-wider border ${s.bg} ${s.text} ${s.border}`}>
                      {c.status || 'active'}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 text-xs text-slate-400">
                    <MapPin className="w-3 h-3" />
                    {c.location}
                  </div>
                  {c.am_owner && (
                    <div className="flex items-center gap-1 mt-1">
                      <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wide">AM</span>
                      <span className="text-[9px] font-bold text-brand-500 bg-brand-50 px-1.5 py-0.5 rounded-md border border-brand-100">{c.am_owner}</span>
                    </div>
                  )}
                </div>
                <span className="text-[10px] font-bold text-slate-400 bg-slate-100 px-2 py-1 rounded-lg shrink-0">
                  {c.industry || c.type}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2.5 mb-4">
                {[
                  { label: 'Mkt. Investment', value: fmt$$(c.total_spend) },
                  { label: 'Revenue',          value: fmt$$(c.total_revenue) },
                  { label: 'New Leads',        value: fmtN(c.total_leads) },
                  { label: 'Jobs Won',         value: fmtN(c.total_closed) },
                ].map(m => (
                  <div key={m.label} className="bg-slate-50 rounded-xl p-3">
                    <p className="text-[10px] text-slate-400 font-semibold mb-0.5 uppercase tracking-wide">{m.label}</p>
                    <p className="font-black text-slate-900 text-sm">{m.value}</p>
                  </div>
                ))}
              </div>

              <div className="flex items-center justify-between pt-3 border-t border-slate-100">
                <div className="flex items-center gap-1.5 text-xs text-slate-500">
                  <TrendingUp className="w-3.5 h-3.5 text-brand-500" />
                  <span>ROI <strong className="text-slate-700">{fmtX(roi)}</strong></span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-slate-500">
                    Win rate <strong className="text-slate-700">{fmtPct(winRate)}</strong>
                  </span>
                  {/* Agency-only: write update / goals / delete */}
                  {(!USE_API || isAgency()) && (
                    <>
                      <button
                        onClick={e => { e.stopPropagation(); setEditClient(c) }}
                        title="Write update / set goals"
                        className="p-1.5 rounded-lg text-slate-300 hover:text-brand-500 hover:bg-brand-50 transition-colors"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={e => { e.stopPropagation(); setDeleteTarget(c) }}
                        title="Delete client"
                        className="p-1.5 rounded-lg text-slate-300 hover:text-rose-500 hover:bg-rose-50 transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </>
                  )}
                </div>
              </div>
              {(!USE_API || isAgency()) && (
                <div className="flex items-center gap-2 pt-2 mt-2 border-t border-slate-50">
                  <button
                    onClick={e => { e.stopPropagation(); store.setSelectedClient(c.id); navigate('/my-dashboard') }}
                    className="flex-1 text-center text-[10px] font-bold text-brand-500 hover:text-brand-700 hover:bg-brand-50 py-1.5 rounded-lg transition-colors border border-brand-100"
                  >
                    Call Prep →
                  </button>
                  <button
                    onClick={e => { e.stopPropagation(); navigate('/intelligence') }}
                    className="flex-1 text-center text-[10px] font-bold text-slate-500 hover:text-slate-700 hover:bg-slate-50 py-1.5 rounded-lg transition-colors border border-slate-100"
                  >
                    Intel →
                  </button>
                </div>
              )}
            </div>
          )
        })}

        {/* Empty-state add card */}
        {(!USE_API || isAgency()) && (
          <button
            onClick={() => setShowModal(true)}
            className="card p-5 border-2 border-dashed border-slate-200 hover:border-brand-300 hover:bg-brand-50/30 transition-all flex flex-col items-center justify-center gap-3 min-h-[200px] group"
          >
            <div className="w-10 h-10 rounded-2xl bg-slate-100 group-hover:bg-brand-100 flex items-center justify-center transition-colors">
              <Plus className="w-5 h-5 text-slate-400 group-hover:text-brand-500 transition-colors" />
            </div>
            <div className="text-center">
              <p className="text-sm font-black text-slate-500 group-hover:text-brand-500 transition-colors">Add New Client</p>
              <p className="text-xs text-slate-400 mt-0.5">Connect GHL, Google Ads, Meta</p>
            </div>
          </button>
        )}
      </div>

      {showModal && (
        <AddClientModal
          onClose={() => setShowModal(false)}
          onCreated={handleCreated}
          amOwners={amOwners}
        />
      )}

      {editClient && (
        <ClientUpdateModal
          client={editClient}
          onClose={() => setEditClient(null)}
        />
      )}

      {deleteTarget && (
        <DeleteClientModal
          client={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={handleDeleted}
        />
      )}
    </div>
  )
}
