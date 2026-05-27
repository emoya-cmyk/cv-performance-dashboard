import { useState, useEffect, useCallback } from 'react'
import {
  CheckCircle2, XCircle, AlertTriangle,
  ChevronDown, ChevronRight,
  Eye, EyeOff, Loader2, Trash2, FlaskConical,
} from 'lucide-react'
import TopBar from '@/components/TopBar'
import { api } from '@/lib/api'
import { useOutletContext } from 'react-router-dom'

// ── Channel definitions ───────────────────────────────────────────────────────
const CHANNELS = [
  {
    id: 'ghl', label: 'GoHighLevel (GHL)', color: '#7c3aed',
    fields: [
      { key: 'location_id', label: 'Location ID',               hint: 'Sub-account location ID from GHL URL',              secret: false },
      { key: 'api_key',     label: 'Private Integration Token', hint: 'GHL → Settings → API → Private Integrations → New', secret: true  },
    ],
  },
  {
    id: 'google_ads', label: 'Google Ads', color: '#4285f4',
    fields: [
      { key: 'customer_id',     label: 'Customer ID',          hint: 'Format: 123-456-7890 (from Ads account)',            secret: false },
      { key: 'developer_token', label: 'Developer Token',      hint: 'Google Ads API Center → Developer Token',            secret: true  },
      { key: 'refresh_token',   label: 'OAuth Refresh Token',  hint: 'OAuth Playground → scope: https://www.googleapis.com/auth/adwords', secret: true },
      { key: 'client_id',       label: 'OAuth Client ID',      hint: 'Google Cloud Console → Credentials (or set GOOGLE_CLIENT_ID env var)', secret: false },
      { key: 'client_secret',   label: 'OAuth Client Secret',  hint: 'Google Cloud Console → Credentials',                 secret: true  },
    ],
  },
  {
    id: 'lsa', label: 'Google LSA', color: '#00acc1',
    fields: [
      { key: 'customer_id',     label: 'Google Ads Customer ID', hint: 'Same Ads account running your LSA campaigns',        secret: false },
      { key: 'developer_token', label: 'Developer Token',        hint: 'Google Ads API Center → Developer Token',            secret: true  },
      { key: 'refresh_token',   label: 'OAuth Refresh Token',    hint: 'Same token as Google Ads if same Cloud project',    secret: true  },
      { key: 'client_id',       label: 'OAuth Client ID',        hint: 'Optional — or set GOOGLE_CLIENT_ID env var',        secret: false },
      { key: 'client_secret',   label: 'OAuth Client Secret',    hint: 'Optional — or set GOOGLE_CLIENT_SECRET env var',   secret: true  },
    ],
  },
  {
    id: 'meta', label: 'Meta Ads', color: '#1877f2',
    fields: [
      { key: 'account_id',   label: 'Ad Account ID',            hint: 'Numeric ID or act_XXXXXXXXXX from Business Manager', secret: false },
      { key: 'access_token', label: 'System User Access Token', hint: 'Meta Business Manager → System Users → Generate Token (ads_read scope)', secret: true },
    ],
  },
  {
    id: 'gbp', label: 'Google Business Profile', color: '#34a853',
    fields: [
      { key: 'location_id',   label: 'Location ID',         hint: 'Numeric ID from GBP dashboard URL',           secret: false },
      { key: 'refresh_token', label: 'OAuth Refresh Token', hint: 'OAuth Playground → scope: https://www.googleapis.com/auth/business.manage', secret: true },
      { key: 'client_id',     label: 'OAuth Client ID',     hint: 'Optional — or set GOOGLE_CLIENT_ID env var',  secret: false },
      { key: 'client_secret', label: 'OAuth Client Secret', hint: 'Optional — or set GOOGLE_CLIENT_SECRET env var', secret: true },
    ],
  },
  {
    id: 'ga4', label: 'GA4 / Analytics', color: '#ff8800',
    fields: [
      { key: 'property_id',   label: 'Property ID',         hint: 'Admin → Property Settings → Property ID (numbers only)', secret: false },
      { key: 'client_id',     label: 'OAuth Client ID',     hint: 'Google Cloud Console → Credentials',                     secret: false },
      { key: 'client_secret', label: 'OAuth Client Secret', hint: 'Google Cloud Console → Credentials',                     secret: true  },
      { key: 'refresh_token', label: 'Refresh Token',       hint: 'OAuth Playground → scope: https://www.googleapis.com/auth/analytics.readonly', secret: true },
    ],
  },
]

// ── Secret field with show / hide toggle ─────────────────────────────────────
function SecretInput({ value, onChange, savedPlaceholder }) {
  const [show, setShow] = useState(false)
  return (
    <div className="relative">
      <input
        type={show ? 'text' : 'password'}
        value={value}
        onChange={onChange}
        placeholder={savedPlaceholder ? '(saved — enter new value to change)' : '••••••••••••'}
        className="w-full pr-9 text-sm"
      />
      <button
        type="button"
        onClick={() => setShow(s => !s)}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
      >
        {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
      </button>
    </div>
  )
}

// ── Per-channel card ──────────────────────────────────────────────────────────
function ChannelCard({ channel, conn, clientId, onSaved }) {
  const [open,       setOpen]       = useState(false)
  const [creds,      setCreds]      = useState({})
  const [saving,     setSaving]     = useState(false)
  const [testing,    setTesting]    = useState(false)
  const [removing,   setRemoving]   = useState(false)
  const [testResult, setTestResult] = useState(null) // { ok, msg }
  const [saveMsg,    setSaveMsg]    = useState('')
  const [err,        setErr]        = useState('')

  const isConnected = !!conn?.is_active

  function handleCred(key) {
    return e => setCreds(c => ({ ...c, [key]: e.target.value }))
  }

  async function handleSave(e) {
    e.preventDefault()
    setSaving(true); setErr(''); setSaveMsg(''); setTestResult(null)
    try {
      await api.saveConnection(clientId, channel.id, creds)
      setSaveMsg('Saved!')
      setCreds({}) // clear — don't keep secrets in state after save
      onSaved()
      setTimeout(() => setSaveMsg(''), 3000)
    } catch (ex) { setErr(ex.message) }
    finally { setSaving(false) }
  }

  async function handleTest() {
    setTesting(true); setTestResult(null); setErr('')
    try {
      const r = await api.testConnection(clientId, channel.id)
      setTestResult({ ok: true, msg: r.message || 'Connection verified' })
    } catch (ex) { setTestResult({ ok: false, msg: ex.message }) }
    finally { setTesting(false) }
  }

  async function handleRemove() {
    // eslint-disable-next-line no-restricted-globals
    if (!confirm(`Remove ${channel.label} credentials for this client?`)) return
    setRemoving(true)
    try {
      await api.deleteConnection(clientId, channel.id)
      onSaved()
      setOpen(false)
    } catch (ex) { setErr(ex.message) }
    finally { setRemoving(false) }
  }

  return (
    <div className={`card transition-all ${open ? 'ring-1 ring-white/10' : ''}`}>
      {/* ── Header / toggle row ── */}
      <button
        type="button"
        onClick={() => { setOpen(o => !o); setErr(''); setTestResult(null) }}
        className="w-full flex items-center gap-3 text-left"
      >
        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: channel.color }} />
        <span className="flex-1 text-sm font-semibold text-white">{channel.label}</span>

        {isConnected ? (
          <span className="flex items-center gap-1 text-xs font-medium text-green-400">
            <CheckCircle2 className="w-3.5 h-3.5" /> Connected
          </span>
        ) : conn?.last_error ? (
          <span className="flex items-center gap-1 text-xs font-medium text-yellow-400">
            <AlertTriangle className="w-3.5 h-3.5" /> Error
          </span>
        ) : (
          <span className="flex items-center gap-1 text-xs font-medium text-slate-500">
            <XCircle className="w-3.5 h-3.5" /> Not configured
          </span>
        )}

        {open
          ? <ChevronDown  className="w-4 h-4 text-slate-400 shrink-0" />
          : <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />}
      </button>

      {/* Collapsed: show last-error or last-synced hint */}
      {!open && conn?.last_error && (
        <p className="mt-2 text-xs text-yellow-300/80 bg-yellow-400/10 rounded px-2 py-1 leading-snug">
          {conn.last_error}
        </p>
      )}
      {!open && isConnected && conn?.last_synced_at && (
        <p className="mt-1 text-[11px] text-slate-500">
          Synced {new Date(conn.last_synced_at).toLocaleDateString()}
        </p>
      )}

      {/* ── Expanded form ── */}
      {open && (
        <form onSubmit={handleSave} className="mt-4 pt-4 border-t border-white/5 space-y-3">
          {channel.fields.map(f => (
            <div key={f.key}>
              <label className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide block mb-1">
                {f.label}
              </label>
              {f.secret ? (
                <SecretInput
                  value={creds[f.key] || ''}
                  onChange={handleCred(f.key)}
                  savedPlaceholder={isConnected}
                />
              ) : (
                <input
                  type="text"
                  value={creds[f.key] || ''}
                  onChange={handleCred(f.key)}
                  placeholder={isConnected ? '(saved — enter new value to change)' : ''}
                  className="w-full text-sm"
                />
              )}
              {f.hint && <p className="mt-0.5 text-[11px] text-slate-500">{f.hint}</p>}
            </div>
          ))}

          {/* Inline feedback */}
          {err && (
            <p className="text-xs text-red-400 flex items-center gap-1">
              <XCircle className="w-3.5 h-3.5 shrink-0" />{err}
            </p>
          )}
          {saveMsg && <p className="text-xs text-green-400">✓ {saveMsg}</p>}
          {testResult && (
            <p className={`text-xs ${testResult.ok ? 'text-green-400' : 'text-red-400'}`}>
              {testResult.ok ? '✓ ' : '✗ '}{testResult.msg}
            </p>
          )}

          {/* Action row */}
          <div className="flex items-center gap-2 pt-1 flex-wrap">
            <button
              type="submit"
              disabled={saving}
              className="bg-brand-500 hover:bg-brand-600 text-white text-xs font-semibold px-3 py-1.5 rounded-lg flex items-center gap-1 disabled:opacity-50"
            >
              {saving && <Loader2 className="w-3 h-3 animate-spin" />}
              {saving ? 'Saving…' : 'Save Credentials'}
            </button>

            {isConnected && (
              <button
                type="button"
                onClick={handleTest}
                disabled={testing}
                className="text-xs px-3 py-1.5 rounded-lg border border-white/10 text-slate-300 hover:bg-white/5 flex items-center gap-1 disabled:opacity-50"
              >
                {testing
                  ? <Loader2 className="w-3 h-3 animate-spin" />
                  : <FlaskConical className="w-3 h-3" />}
                {testing ? 'Testing…' : 'Test Connection'}
              </button>
            )}

            {isConnected && (
              <button
                type="button"
                onClick={handleRemove}
                disabled={removing}
                className="ml-auto text-xs px-2 py-1.5 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-400/10 flex items-center gap-1 disabled:opacity-50"
                title="Remove credentials"
              >
                {removing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
              </button>
            )}
          </div>
        </form>
      )}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function ConnectionsPage() {
  const store = useOutletContext()

  const [clients,  setClients]  = useState([])
  const [clientId, setClientId] = useState('')
  const [conns,    setConns]    = useState([])
  const [loading,  setLoading]  = useState(false)

  // Load client list once
  useEffect(() => {
    api.clients().then(list => {
      setClients(list)
      if (list.length) setClientId(list[0].id)
    }).catch(() => {})
  }, [])

  // Reload connection statuses whenever the selected client changes
  const loadConns = useCallback(() => {
    if (!clientId) return
    setLoading(true)
    api.listConnections(clientId)
      .then(setConns)
      .catch(() => setConns([]))
      .finally(() => setLoading(false))
  }, [clientId])

  useEffect(() => { loadConns() }, [loadConns])

  // Channel id → connection record
  const connMap = Object.fromEntries(conns.map(c => [c.channel, c]))

  const selectedClient = clients.find(c => c.id === clientId)

  return (
    <div className="flex flex-col h-full">
      <TopBar title="Connections" store={store} />

      <div className="flex-1 overflow-auto p-6 max-w-3xl space-y-6">

        {/* Heading + client picker */}
        <div>
          <h2 className="text-lg font-bold text-white mb-1">API Connections</h2>
          <p className="text-sm text-slate-400 mb-4">
            Enter credentials for each data source. Secrets are encrypted at rest and never returned by the API.
          </p>
          <div className="flex items-center gap-3">
            <label className="text-xs font-semibold text-slate-400 uppercase tracking-wide shrink-0">
              Client
            </label>
            <select
              value={clientId}
              onChange={e => setClientId(e.target.value)}
              className="bg-surface-2 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none"
            >
              {clients.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Channel cards */}
        {loading ? (
          <div className="flex items-center gap-2 text-slate-400 text-sm py-4">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading connections…
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {CHANNELS.map(ch => (
              <ChannelCard
                key={ch.id}
                channel={ch}
                conn={connMap[ch.id] ?? null}
                clientId={clientId}
                onSaved={loadConns}
              />
            ))}
          </div>
        )}

        {/* Client record IDs reminder */}
        {selectedClient && (
          <div className="card-sm text-xs text-slate-400 space-y-1.5">
            <p className="font-semibold text-slate-300 text-xs">Client record IDs</p>
            <p>
              GHL Location ID:{' '}
              <span className="font-mono text-slate-200">{selectedClient.ghl_location_id || '—'}</span>
            </p>
            <p>
              HubSpot Portal ID:{' '}
              <span className="font-mono text-slate-200">{selectedClient.hubspot_portal_id || '—'}</span>
            </p>
            <p className="text-slate-500 text-[11px]">
              Update these on the Clients page → pencil icon.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
