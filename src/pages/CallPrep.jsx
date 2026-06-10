import { useState, useEffect, useCallback } from 'react'
import {
  PhoneCall, RefreshCw, Copy, Check, ChevronDown,
  Trophy, AlertTriangle, MessageSquare, Zap, Mail,
  Sparkles, User,
} from 'lucide-react'
import { api, USE_API } from '@/lib/api'
import { useOutletContext } from 'react-router-dom'

// ── Mock data for dev/demo mode ────────────────────────────────────────────
const MOCK_PREP = {
  headline: 'Generation Floors closed 7 jobs for $42,800 this week with a 12.4× ROAS — strongest revenue week of Q2.',
  wins: [
    'Google Ads ROAS hit 12.4× this week — for every $1 spent you\'re getting $12.40 back, placing you in the top tier for home services.',
    '7 jobs closed at an average ticket of $6,114, with total revenue up 23% vs last week. The pipeline is converting.',
    'LSA delivered 18 qualified calls at zero cost-per-click — the most cost-efficient channel in the mix right now.',
  ],
  watchouts: [
    'Meta CPL is running at $87 vs the $65 target — worth rotating creative this week before spend compounds into next week.',
    'Close rate was 38% vs a 45% trailing average — worth checking whether any warm leads slipped through without a follow-up call.',
  ],
  talking_points: [
    'Open with the win: this was your best revenue week of Q2 — 7 jobs closed, $42,800 tracked. Your pipeline is clearly converting right now.',
    'Your Google Ads are earning their keep at a 12.4× ROAS — that\'s exceptional for flooring. We\'re protecting that efficiency as we scale spend.',
    'LSA is firing — 18 calls came in this week at no cost-per-click. This is your most efficient lead source and we\'re keeping it fully optimized.',
    'I want to get ahead of the Meta CPL — it crept up to $87 this week. I already have new creative assets queued up and we\'ll rotate them in Monday.',
    'Next week: I\'m pulling your warmest uncontacted leads from the last 14 days so nothing slips through. First-contact speed is often the difference in closing home services jobs.',
  ],
  next_action: 'Pull the Lead Pipeline report and identify any leads from the last 14 days without a logged follow-up — these are your highest-probability closes this week.',
  email_subject: 'Generation Floors — Week Recap: 7 Jobs, $42.8K Revenue, 12.4× ROAS',
  client_name: 'Generation Floors',
  week_start: '2026-06-02',
  fallback: false,
}

// ── Utilities ──────────────────────────────────────────────────────────────
function weekLabel(iso) {
  if (!iso) return ''
  const d = new Date(iso + 'T00:00:00Z')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function buildCopyText(prep) {
  if (!prep) return ''
  return [
    `📋 CALL PREP — ${prep.client_name || ''} (week of ${weekLabel(prep.week_start)})`,
    '',
    `HEADLINE`,
    prep.headline,
    '',
    `✅ WINS TO HIGHLIGHT`,
    ...(prep.wins || []).map((w, i) => `${i + 1}. ${w}`),
    '',
    `⚠️  WATCH OUTS`,
    ...(prep.watchouts || []).map((w, i) => `${i + 1}. ${w}`),
    '',
    `💬 TALKING POINTS`,
    ...(prep.talking_points || []).map((t, i) => `${i + 1}. ${t}`),
    '',
    `⚡ NEXT ACTION`,
    prep.next_action,
    '',
    `📧 EMAIL SUBJECT`,
    prep.email_subject,
  ].join('\n')
}

// Small copy-to-clipboard hook with a brief ✓ flash
function useCopy(text) {
  const [copied, setCopied] = useState(false)
  const copy = useCallback(() => {
    navigator.clipboard.writeText(text).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }, [text])
  return { copied, copy }
}

// ── Section cards ──────────────────────────────────────────────────────────
function SectionCard({ icon: Icon, title, accent, items, numbered }) {
  const [copiedIdx, setCopiedIdx] = useState(null)

  function copyItem(text, idx) {
    navigator.clipboard.writeText(text).catch(() => {})
    setCopiedIdx(idx)
    setTimeout(() => setCopiedIdx(null), 1600)
  }

  return (
    <div className={`rounded-2xl border ${accent.border} bg-white/[.02] overflow-hidden`}>
      <div className={`flex items-center gap-2.5 px-4 py-3 border-b ${accent.border} ${accent.bg}`}>
        <Icon className={`w-4 h-4 ${accent.icon} shrink-0`} />
        <p className={`text-xs font-black uppercase tracking-wider ${accent.label}`}>{title}</p>
      </div>
      <ul className="divide-y divide-white/5">
        {items.map((text, i) => (
          <li key={i} className="group flex items-start gap-3 px-4 py-3.5">
            {numbered && (
              <span className={`shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-black mt-0.5 ${accent.numBg} ${accent.icon}`}>
                {i + 1}
              </span>
            )}
            <p className="text-sm text-slate-200 leading-relaxed flex-1">{text}</p>
            <button
              onClick={() => copyItem(text, i)}
              className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0 p-1 rounded-lg text-slate-500 hover:text-slate-300"
              title="Copy"
            >
              {copiedIdx === i
                ? <Check className="w-3 h-3 text-emerald-400" />
                : <Copy className="w-3 h-3" />
              }
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────
export default function CallPrep() {
  const ctx = useOutletContext()
  const clients  = ctx?.clients  ?? []
  const selected = ctx?.selectedClient ?? null
  const setSelected = ctx?.setSelectedClient ?? (() => {})

  const [prep, setPrep]       = useState(null)
  const [status, setStatus]   = useState('idle')   // idle | loading | done | error
  const [regen, setRegen]     = useState(false)
  const [errMsg, setErrMsg]   = useState('')

  // Load prep whenever client changes
  useEffect(() => {
    if (!selected || selected === 'all') { setPrep(null); setStatus('idle'); return }
    if (!USE_API)  { setPrep(MOCK_PREP); setStatus('done'); return }

    setStatus('loading')
    setPrep(null)
    api.getCallPrep(selected)
      .then(r => { setPrep(r); setStatus('done') })
      .catch(e => { setErrMsg(e.message); setStatus('error') })
  }, [selected])

  async function handleRegen() {
    if (!USE_API || !selected || regen) return
    setRegen(true)
    try {
      const r = await api.generateCallPrep(selected)
      setPrep(r); setStatus('done')
    } catch (e) {
      setErrMsg(e.message); setStatus('error')
    } finally {
      setRegen(false)
    }
  }

  const copyText  = buildCopyText(prep)
  const { copied: allCopied, copy: copyAll } = useCopy(copyText)
  const { copied: subjectCopied, copy: copySubject } = useCopy(prep?.email_subject || '')

  return (
    <div className="min-h-screen bg-surface text-slate-100">
      {/* Header */}
      <div className="border-b border-white/5 px-6 py-5">
        <div className="max-w-4xl mx-auto flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-2.5 mb-1">
              <PhoneCall className="w-5 h-5 text-brand-400" />
              <h1 className="text-lg font-black text-white">Call Prep</h1>
            </div>
            <p className="text-sm text-slate-400">
              AI-generated talking points for your client performance call — grounded in this week's actual numbers.
            </p>
          </div>
          {prep && (
            <button
              onClick={copyAll}
              className="flex items-center gap-2 px-4 py-2 bg-brand-500/10 hover:bg-brand-500/20 border border-brand-500/20 rounded-xl text-sm font-bold text-brand-400 transition-colors shrink-0"
            >
              {allCopied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              {allCopied ? 'Copied!' : 'Copy All'}
            </button>
          )}
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-6 py-6 space-y-5">
        {/* Client selector */}
        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative">
            <User className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500 pointer-events-none" />
            <select
              value={selected || ''}
              onChange={e => setSelected(e.target.value || null)}
              className="pl-8 pr-8 py-2 rounded-xl bg-surface-2 border border-white/10 text-sm text-slate-200 appearance-none focus:outline-none focus:border-brand-500/50 cursor-pointer min-w-[200px]"
            >
              <option value="">Select a client…</option>
              {clients.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500 pointer-events-none" />
          </div>

          {prep && (
            <button
              onClick={handleRegen}
              disabled={regen}
              className="flex items-center gap-2 px-4 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-sm font-medium text-slate-400 hover:text-slate-200 transition-colors disabled:opacity-40"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${regen ? 'animate-spin' : ''}`} />
              {regen ? 'Regenerating…' : 'Regenerate'}
            </button>
          )}

          {prep?.week_start && (
            <span className="text-xs text-slate-500 font-medium">
              Week of {weekLabel(prep.week_start)}
              {prep.fallback && ' · template'}
              {prep.cached_at && !prep.fallback && ' · cached'}
            </span>
          )}
        </div>

        {/* Empty state */}
        {!selected && (
          <div className="border border-white/5 border-dashed rounded-2xl px-6 py-12 text-center">
            <PhoneCall className="w-8 h-8 text-brand-400/30 mx-auto mb-3" />
            <p className="text-sm font-bold text-slate-400">Select a client to generate call prep</p>
            <p className="text-xs text-slate-600 mt-1">Talking points are grounded in this week's live performance data</p>
          </div>
        )}

        {/* Loading */}
        {status === 'loading' && (
          <div className="border border-white/5 rounded-2xl px-6 py-10 text-center">
            <Sparkles className="w-6 h-6 text-brand-400/50 mx-auto mb-3 animate-pulse" />
            <p className="text-sm text-slate-400 font-medium">Preparing your talking points…</p>
            <p className="text-xs text-slate-600 mt-1">Reading this week's metrics + active insights</p>
          </div>
        )}

        {/* Error */}
        {status === 'error' && (
          <div className="border border-red-500/20 bg-red-500/5 rounded-2xl px-5 py-4">
            <p className="text-sm text-red-400 font-bold">Failed to generate call prep</p>
            <p className="text-xs text-slate-500 mt-1">{errMsg}</p>
          </div>
        )}

        {/* Results */}
        {status === 'done' && prep && (
          <>
            {/* Headline */}
            <div className="bg-gradient-to-r from-brand-500/10 via-violet-500/10 to-sky-500/10 border border-brand-500/20 rounded-2xl px-5 py-4">
              <p className="text-[10px] font-black uppercase tracking-wider text-brand-400 mb-2">Week Summary</p>
              <p className="text-base font-bold text-white leading-snug">{prep.headline}</p>
            </div>

            {/* Wins + Watchouts grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <SectionCard
                icon={Trophy}
                title="Wins to Highlight"
                items={prep.wins || []}
                accent={{
                  border: 'border-emerald-500/20',
                  bg:     'bg-emerald-500/5',
                  icon:   'text-emerald-400',
                  label:  'text-emerald-400',
                  numBg:  'bg-emerald-500/10',
                }}
              />
              <SectionCard
                icon={AlertTriangle}
                title="Watch Outs"
                items={prep.watchouts || []}
                accent={{
                  border: 'border-amber-500/20',
                  bg:     'bg-amber-500/5',
                  icon:   'text-amber-400',
                  label:  'text-amber-400',
                  numBg:  'bg-amber-500/10',
                }}
              />
            </div>

            {/* Talking points */}
            <SectionCard
              icon={MessageSquare}
              title="Talking Points"
              items={prep.talking_points || []}
              numbered
              accent={{
                border: 'border-brand-500/20',
                bg:     'bg-brand-500/5',
                icon:   'text-brand-400',
                label:  'text-brand-400',
                numBg:  'bg-brand-500/10',
              }}
            />

            {/* Next action */}
            {prep.next_action && (
              <div className="border border-violet-500/20 bg-violet-500/5 rounded-2xl px-5 py-4">
                <div className="flex items-start gap-3">
                  <Zap className="w-4 h-4 text-violet-400 shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="text-[10px] font-black uppercase tracking-wider text-violet-400 mb-1.5">Next Action</p>
                    <p className="text-sm text-slate-200 leading-relaxed">{prep.next_action}</p>
                  </div>
                </div>
              </div>
            )}

            {/* Email subject */}
            {prep.email_subject && (
              <div className="border border-white/10 bg-white/[.02] rounded-2xl px-4 py-3.5 flex items-center justify-between gap-4">
                <div className="flex items-center gap-2.5 min-w-0">
                  <Mail className="w-4 h-4 text-slate-400 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-0.5">Follow-up Email Subject</p>
                    <p className="text-sm text-slate-300 truncate font-medium">{prep.email_subject}</p>
                  </div>
                </div>
                <button
                  onClick={copySubject}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-xs font-bold text-slate-400 hover:text-slate-200 transition-colors shrink-0"
                >
                  {subjectCopied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                  {subjectCopied ? 'Copied' : 'Copy'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
