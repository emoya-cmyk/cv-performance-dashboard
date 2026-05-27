import { useState, useEffect } from 'react'
import { Settings2, TrendingUp, Check, AlertCircle } from 'lucide-react'
import TopBar from '@/components/TopBar'
import { api, USE_API, post } from '@/lib/api'
import { useAgency, applyBrandColor, clearSettingsCache } from '@/lib/agencySettings'
import { useOutletContext } from 'react-router-dom'

// ── Colour preview pill ───────────────────────────────────────────────────────
function ColorSwatch({ hex }) {
  return (
    <span className="inline-block w-6 h-6 rounded-full border border-white/30 shadow-sm shrink-0"
      style={{ background: hex }} />
  )
}

// ── Logo preview (mirrors Sidebar logo area) ──────────────────────────────────
function LogoPreview({ agencyName, accentHex, logoUrl }) {
  return (
    <div className="flex items-center gap-3 bg-navy-900 rounded-2xl px-5 py-4 w-fit">
      {logoUrl ? (
        <img src={logoUrl} alt="logo" className="w-8 h-8 rounded-lg object-contain bg-white/10 p-0.5" />
      ) : (
        <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: accentHex }}>
          <TrendingUp className="w-4 h-4 text-white" />
        </div>
      )}
      <div className="leading-tight">
        <p className="text-xs font-black tracking-widest uppercase" style={{ color: accentHex }}>
          {agencyName.length > 12 ? agencyName.slice(0, 12) + '…' : agencyName}
        </p>
        <p className="text-[11px] text-slate-400 font-medium">Performance</p>
      </div>
    </div>
  )
}

export default function SettingsPage() {
  const store   = useOutletContext()
  const current = useAgency()

  const [form, setForm]       = useState({ agency_name: '', accent_hex: '#e53935', logo_url: '', contact_email: '', calendar_url: '' })
  const [saving, setSaving]   = useState(false)
  const [success, setSuccess] = useState(false)
  const [error, setError]     = useState('')

  // Seed form from context once it loads
  useEffect(() => {
    setForm({
      agency_name:   current.agency_name   || '10X Performance',
      accent_hex:    current.accent_hex    || '#e53935',
      logo_url:      current.logo_url      || '',
      contact_email: current.contact_email || '',
      calendar_url:  current.calendar_url  || '',
    })
  }, [current])

  // Live-preview the colour as the picker changes
  function handleColorChange(hex) {
    setForm(f => ({ ...f, accent_hex: hex }))
    applyBrandColor(hex)
  }

  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }))

  async function handleSave(e) {
    e.preventDefault()
    if (!form.agency_name.trim()) { setError('Agency name is required'); return }
    setSaving(true); setError('')
    try {
      // post() is exported from api.js; settings route is a plain PUT
      const res = await fetch(`${import.meta.env.VITE_API_URL || ''}/api/agency/settings`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...(localStorage.getItem('token') ? { Authorization: `Bearer ${localStorage.getItem('token')}` } : {}),
        },
        body: JSON.stringify({
          agency_name:   form.agency_name.trim(),
          accent_hex:    form.accent_hex,
          logo_url:      form.logo_url.trim()      || null,
          contact_email: form.contact_email.trim() || null,
          calendar_url:  form.calendar_url.trim()  || null,
        }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || `Save failed (${res.status})`)
      }
      clearSettingsCache()
      applyBrandColor(form.accent_hex)
      setSuccess(true)
      setTimeout(() => setSuccess(false), 3000)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const inputCls = 'w-full border border-slate-200 rounded-xl px-4 py-2.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent'

  return (
    <div>
      <TopBar
        title="Agency Settings"
        subtitle="White-label your dashboard — clients see your brand, not ours"
        {...store}
        onClientChange={store.setSelectedClient}
        onPeriodChange={store.setSelectedPeriod}
      />

      <div className="max-w-2xl space-y-6">

        {/* ── Branding form ── */}
        <form onSubmit={handleSave} className="card p-6 space-y-6">
          <div className="flex items-center gap-2 pb-2 border-b border-slate-100">
            <Settings2 className="w-4 h-4 text-brand-500" />
            <h2 className="text-sm font-black text-slate-900">Branding</h2>
          </div>

          {/* Agency Name */}
          <div>
            <label className="block text-[10px] font-black uppercase tracking-widest text-slate-500 mb-1.5">
              Agency Name <span className="text-brand-500">*</span>
            </label>
            <input
              value={form.agency_name}
              onChange={set('agency_name')}
              placeholder="10X Performance"
              maxLength={40}
              className={inputCls}
            />
            <p className="text-[10px] text-slate-400 mt-1.5">
              Appears in the sidebar, client view header, and weekly email subject line.
            </p>
          </div>

          {/* Accent Colour */}
          <div>
            <label className="block text-[10px] font-black uppercase tracking-widest text-slate-500 mb-2">
              Brand Colour
            </label>
            <div className="flex items-center gap-3">
              <input
                type="color"
                value={form.accent_hex}
                onChange={e => handleColorChange(e.target.value)}
                className="w-10 h-10 rounded-xl border border-slate-200 cursor-pointer p-0.5 bg-white"
              />
              <input
                value={form.accent_hex}
                onChange={e => {
                  set('accent_hex')(e)
                  if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) applyBrandColor(e.target.value)
                }}
                placeholder="#e53935"
                maxLength={7}
                className="w-32 border border-slate-200 rounded-xl px-4 py-2.5 text-sm font-mono text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
              />
              <ColorSwatch hex={form.accent_hex} />
              <p className="text-[11px] text-slate-400">Live preview — no save needed to see it</p>
            </div>
          </div>

          {/* Logo URL */}
          <div>
            <label className="block text-[10px] font-black uppercase tracking-widest text-slate-500 mb-1.5">
              Logo URL
              <span className="ml-1 normal-case tracking-normal font-normal text-slate-300">(optional — leave blank for icon)</span>
            </label>
            <input
              value={form.logo_url}
              onChange={set('logo_url')}
              placeholder="https://cdn.youragency.com/logo.png"
              className={inputCls}
            />
            <p className="text-[10px] text-slate-400 mt-1.5">
              Square PNG or SVG, min 64×64. Displays at 32×32px in the sidebar and nav.
            </p>
          </div>

          {/* Divider */}
          <div className="border-t border-slate-100 pt-4">
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-4">
              Client Contact Defaults
              <span className="ml-1 normal-case tracking-normal font-normal text-slate-300">— overridable per client</span>
            </p>

            {/* Contact Email */}
            <div className="space-y-4">
              <div>
                <label className="block text-[10px] font-black uppercase tracking-widest text-slate-500 mb-1.5">
                  Contact Email
                </label>
                <input
                  type="email"
                  value={form.contact_email}
                  onChange={set('contact_email')}
                  placeholder="hello@youragency.com"
                  className={inputCls}
                />
                <p className="text-[10px] text-slate-400 mt-1.5">
                  Used in the client review page and shared report footer. Leave blank to hide the "Email Your Team" button.
                </p>
              </div>

              {/* Calendar URL */}
              <div>
                <label className="block text-[10px] font-black uppercase tracking-widest text-slate-500 mb-1.5">
                  Booking / Calendar URL
                </label>
                <input
                  type="url"
                  value={form.calendar_url}
                  onChange={set('calendar_url')}
                  placeholder="https://calendly.com/your-link"
                  className={inputCls}
                />
                <p className="text-[10px] text-slate-400 mt-1.5">
                  Calendly, Cal.com, or any booking URL. Leave blank to hide the "Schedule a Call" button.
                </p>
              </div>
            </div>
          </div>

          {error   && (
            <div className="flex items-center gap-2 bg-rose-50 border border-rose-100 rounded-xl px-4 py-2.5">
              <AlertCircle className="w-4 h-4 text-rose-500 shrink-0" />
              <p className="text-xs text-rose-600 font-semibold">{error}</p>
            </div>
          )}
          {success && (
            <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-100 rounded-xl px-4 py-2.5">
              <Check className="w-4 h-4 text-emerald-500 shrink-0" />
              <p className="text-xs text-emerald-600 font-semibold">Settings saved — all views will reflect your branding</p>
            </div>
          )}

          <div className="flex items-center gap-4 pt-1">
            <button
              type="submit"
              disabled={saving}
              className="bg-brand-500 hover:bg-brand-600 text-white font-black text-sm px-6 py-2.5 rounded-xl transition-colors disabled:opacity-50 shadow-md shadow-brand-500/20"
            >
              {saving ? 'Saving…' : 'Save Branding →'}
            </button>
            <p className="text-[11px] text-slate-400">
              Changes are visible to all users immediately.
            </p>
          </div>
        </form>

        {/* ── Logo Preview ── */}
        <div className="card p-6">
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-4">Sidebar Preview</p>
          <LogoPreview
            agencyName={form.agency_name}
            accentHex={form.accent_hex}
            logoUrl={form.logo_url || null}
          />
        </div>

        {/* ── Email hint ── */}
        <div className="bg-slate-50 border border-slate-100 rounded-2xl px-5 py-4">
          <p className="text-xs font-black text-slate-700 mb-1">Email digest branding</p>
          <p className="text-xs text-slate-500 leading-relaxed">
            The weekly email uses your agency name in the header and subject line. Set{' '}
            <code className="text-[11px] bg-white border border-slate-200 px-1.5 py-0.5 rounded text-slate-600">DIGEST_FROM</code>{' '}
            in your Render env to control the sender address (e.g.{' '}
            <code className="text-[11px] bg-white border border-slate-200 px-1.5 py-0.5 rounded text-slate-600">Your Agency &lt;hi@youragency.com&gt;</code>).
          </p>
        </div>
      </div>
    </div>
  )
}
