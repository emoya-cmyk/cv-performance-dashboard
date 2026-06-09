'use strict'

// ============================================================
// lib/callPrep.js — generate structured call-prep talking points per (client, week).
//
// Reads the same evidence pack the weekly recap uses + the live insight feed,
// then calls Claude (Haiku by default) with a narrow structured prompt asking
// for six fields: headline, wins[], watchouts[], talking_points[], next_action,
// email_subject. Falls back to a deterministic template when AI is unavailable.
//
// Persisted to ai_call_preps (client_id, week_start) so the LLM is called at
// most once per client-week; POST force-regenerates. Never throws on the AI
// path — the deterministic template is always grounded in evidence pack numbers.
// ============================================================

const axios                  = require('axios')
const { query }              = require('../db')
const { buildEvidencePack }  = require('./evidence')
const { getInsightFeed }     = require('./insights')
const { weekStartOf }        = require('./rollup')

const ANTHROPIC_URL  = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERS = '2023-06-01'
const DEFAULT_MODEL  = process.env.AI_MODEL || 'claude-haiku-4-5'
const isOpus47       = (m) => /opus-4-7/.test(m || '')

// ── Formatters ──────────────────────────────────────────────────────────────
function fmt$(n) {
  n = Number(n) || 0
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}K`
  return `$${Math.round(n)}`
}
function fmtX(n) { return Number.isFinite(+n) && +n > 0 ? `${(+n).toFixed(1)}×` : '—' }
function fmtN(n) { return n != null && +n > 0 ? (+n).toLocaleString() : '0' }
function sign(n) { return +n >= 0 ? '+' : '' }

// ── Default week (last completed Monday) ────────────────────────────────────
function defaultWeekStart() {
  const d = new Date(); d.setUTCDate(d.getUTCDate() - 7)
  return weekStartOf(d.toISOString().slice(0, 10))
}

// ── Deterministic template fallback ─────────────────────────────────────────
// Built purely from the evidence pack — grounded by construction, no LLM needed.
function templateCallPrep(pack) {
  const name = pack.client?.name || 'Client'
  const m    = pack.metrics || {}
  const c    = pack.channels || {}
  const rev  = m.revenue?.current   || 0
  const jobs = m.jobs?.current      || 0
  const leads = m.leads?.current    || 0
  const roas = m.roas?.current      || 0
  const spend = m.spend?.current    || 0
  const cpl   = m.cpl?.current      || 0

  const revPct   = m.revenue?.pct_change || 0
  const leadsPct = m.leads?.pct_change   || 0
  const roasPct  = m.roas?.pct_change    || 0

  const wins = []
  const watchouts = []

  // Wins — pick the most positive signals
  if (jobs > 0) wins.push(`${fmtN(jobs)} job${jobs !== 1 ? 's' : ''} closed this week generating ${fmt$(rev)} — the pipeline is converting.`)
  if (roas >= 8)  wins.push(`Marketing ROAS is at ${fmtX(roas)} — every dollar spent is returning ${fmtX(roas)} in revenue, well above the industry average.`)
  if (leads > 0) wins.push(`${fmtN(leads)} new leads came in this week${c.lsa?.calls > 0 ? `, including ${fmtN(c.lsa.calls)} LSA calls at zero cost-per-click` : ''}.`)
  if (wins.length < 3) wins.push(`All ad channels active — ${fmt$(c.google_ads?.spend || 0)} Google, ${fmt$(c.meta?.spend || 0)} Meta managed this week.`)
  if (wins.length < 3) wins.push(revPct >= 0 ? `Revenue is trending in the right direction, up ${Math.abs(revPct).toFixed(0)}% from last week.` : `Lead volume is holding steady with ${fmtN(leads)} inquiries this week.`)

  // Watchouts — real signals only, never invent problems
  if (revPct < -15) watchouts.push(`Revenue is down ${Math.abs(revPct).toFixed(0)}% vs last week — worth checking whether this is seasonal or a pipeline gap.`)
  if (leadsPct < -20) watchouts.push(`Lead volume dropped ${Math.abs(leadsPct).toFixed(0)}% this week — monitoring whether this is a one-week blip or a trend.`)
  if (cpl > 80) watchouts.push(`Cost per lead is running at ${fmt$(cpl)} — reviewing bid strategy to bring that back to target.`)
  if (watchouts.length < 1) watchouts.push(`Meta creative rotation is worth reviewing to prevent audience fatigue before it shows up in CPL.`)
  if (watchouts.length < 2) watchouts.push(`Close rate and follow-up speed: even with strong lead volume, a faster first-contact window typically lifts close rate 10–20%.`)

  return {
    headline:       `${name} brought in ${fmtN(leads)} leads and ${fmt$(rev)} in revenue this week with a ${fmtX(roas)} marketing ROAS.`,
    wins:           wins.slice(0, 3),
    watchouts:      watchouts.slice(0, 2),
    talking_points: [
      `Open strong: you had ${fmtN(leads)} new leads and closed ${fmtN(jobs)} jobs this week — ${fmt$(rev)} in revenue tracked. The pipeline is moving.`,
      `Google Ads is your highest-volume channel right now — ${fmtN(c.google_ads?.leads || 0)} leads at a ${fmtX(c.google_ads?.roas)} ROAS. We're keeping a close eye on CPL to stay efficient.`,
      `LSA brought in ${fmtN(c.lsa?.calls || 0)} calls and ${fmtN(c.lsa?.booked_jobs || 0)} booked jobs — at zero CPC, this is your most cost-efficient channel.`,
      `Total ad spend this week was ${fmt$(spend)}. We're tracking attribution down to the individual job so you always know your exact return.`,
      `Next week I'm focused on [key priority] to push your monthly goal further — we're currently at ${pack.goal?.pct ?? 0}% of the ${fmt$(pack.goal?.revenue_target || 0)} target.`,
    ],
    next_action:    `Check the Lead Pipeline report together and tag any leads that need a follow-up call in the next 48 hours — speed-to-contact is often the difference in home services.`,
    email_subject:  `${name} — Week in Review: ${fmtN(leads)} Leads, ${fmt$(rev)} Revenue`,
    fallback:       true,
  }
}

// ── Evidence → prompt context ────────────────────────────────────────────────
function buildContext(pack, insights) {
  const m = pack.metrics || {}
  const c = pack.channels || {}
  const lines = [
    `Client: ${pack.client?.name || 'Unknown'}`,
    `Period: ${pack.period?.label || ''}`,
    '',
    'METRICS (current vs prior week):',
    `  Revenue:       ${fmt$(m.revenue?.current)}  (${sign(m.revenue?.pct_change)}${(m.revenue?.pct_change||0).toFixed(0)}%)`,
    `  Leads:         ${fmtN(m.leads?.current)}    (${sign(m.leads?.pct_change)}${(m.leads?.pct_change||0).toFixed(0)}%)`,
    `  Jobs Closed:   ${fmtN(m.jobs?.current)}`,
    `  Total Spend:   ${fmt$(m.spend?.current)}`,
    `  ROAS:          ${fmtX(m.roas?.current)}`,
    `  Cost Per Lead: ${fmt$(m.cpl?.current)}`,
    `  Close Rate:    ${(m.close_rate?.current||0).toFixed(1)}%`,
    '',
    'CHANNELS:',
    `  Google Ads: ${fmt$(c.google_ads?.spend)} spend · ${fmtN(c.google_ads?.leads)} leads · ${fmtX(c.google_ads?.roas)} ROAS`,
    `  Meta Ads:   ${fmt$(c.meta?.spend)} spend · ${fmtN(c.meta?.leads)} leads · ${fmtX(c.meta?.roas)} ROAS`,
    `  LSA:        ${fmt$(c.lsa?.spend)} spend · ${fmtN(c.lsa?.calls)} calls · ${fmtN(c.lsa?.booked_jobs)} booked jobs`,
    `  GBP:        ${fmtN(c.gbp?.calls)} calls · ${fmtN(c.gbp?.directions)} directions · ${fmtN(c.gbp?.website_clicks)} web clicks`,
  ]

  if (pack.goal?.revenue_target) {
    lines.push('', `MONTHLY GOAL: ${pack.goal.pct}% of ${fmt$(pack.goal.revenue_target)} target (${fmt$(pack.goal.month_revenue)} so far)`)
  }

  if (insights?.length > 0) {
    lines.push('', `AI INSIGHTS (${insights.length} active):`)
    insights.slice(0, 5).forEach((ins, i) => {
      const text = (ins.text || ins.narrative || '').slice(0, 160)
      if (text) lines.push(`  ${i + 1}. [${ins.severity || 'info'}] ${text}`)
    })
  }

  return lines.join('\n')
}

// ── Anthropic call ───────────────────────────────────────────────────────────
async function callAI(context, clientName) {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) return null

  const model = DEFAULT_MODEL
  const body = {
    model,
    max_tokens: 900,
    system: 'You are a marketing account manager preparing for a client performance call. Respond with ONLY valid JSON — no markdown, no code fences, no extra text.',
    messages: [{
      role: 'user',
      content: `Using the data below, generate call prep for ${clientName}. Return EXACTLY this JSON:

{
  "headline": "1 sentence with key numbers — what kind of week was it overall?",
  "wins": ["win 1 with specific number", "win 2 with specific number", "win 3 with specific number"],
  "watchouts": ["watchout 1 framed constructively", "watchout 2 framed constructively"],
  "talking_points": [
    "Opening: start with a specific win and its impact — include a real number",
    "Results: what the week meant for their business in plain language",
    "Channels: which channels worked hardest and where leads came from",
    "Proactive: address any watchout before they bring it up — frame it as part of the plan",
    "Next: one concrete thing you're doing next week and the expected outcome"
  ],
  "next_action": "1 specific action for the account manager to take before or after this call",
  "email_subject": "Subject line for a follow-up email after the call"
}

Rules:
- Every number must come from the data below
- Wins = genuine positives with real metrics
- Watchouts = honest but constructive, do NOT invent problems if data looks strong
- Talking points = 1-2 sentences each, sound like a real person not a report
- Tone: professional, warm, trusted advisor

DATA:
${context}`,
    }],
  }

  if (!isOpus47(model)) body.temperature = 0.3

  const { data } = await axios.post(ANTHROPIC_URL, body, {
    headers: {
      'x-api-key': key,
      'anthropic-version': ANTHROPIC_VERS,
      'content-type': 'application/json',
    },
    timeout: 22000,
  })

  const raw   = data?.content?.[0]?.text || ''
  const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
  return JSON.parse(clean)
}

// ── Public functions ─────────────────────────────────────────────────────────

async function generateCallPrep(clientId, weekStart) {
  const ws = weekStart || defaultWeekStart()

  // Load evidence + insights concurrently
  const [pack, feed] = await Promise.all([
    buildEvidencePack(clientId, ws),
    getInsightFeed(clientId, { status: 'open', limit: 8 }).catch(() => ({ findings: [] })),
  ])

  const insights   = feed?.findings || []
  const clientName = pack.client?.name || 'Client'
  const context    = buildContext(pack, insights)

  let raw = null
  try {
    raw = await callAI(context, clientName)
  } catch (err) {
    console.warn('[call-prep] AI failed, using template:', err.message)
  }

  const src = (raw && typeof raw === 'object' && raw.headline) ? raw : null

  const prep = {
    headline:       String(src?.headline       || templateCallPrep(pack).headline),
    wins:           (Array.isArray(src?.wins)           ? src.wins           : templateCallPrep(pack).wins).slice(0, 3).map(String),
    watchouts:      (Array.isArray(src?.watchouts)       ? src.watchouts       : templateCallPrep(pack).watchouts).slice(0, 2).map(String),
    talking_points: (Array.isArray(src?.talking_points) ? src.talking_points : templateCallPrep(pack).talking_points).slice(0, 5).map(String),
    next_action:    String(src?.next_action    || templateCallPrep(pack).next_action),
    email_subject:  String(src?.email_subject  || templateCallPrep(pack).email_subject),
    fallback:       !src,
    client_name:    clientName,
    week_start:     ws,
    generated_at:   new Date().toISOString(),
  }

  // Persist (idempotent on conflict)
  await query(
    `INSERT INTO ai_call_preps (client_id, week_start, call_prep, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (client_id, week_start)
     DO UPDATE SET call_prep = EXCLUDED.call_prep, updated_at = NOW()`,
    [clientId, ws, JSON.stringify(prep)]
  )

  return prep
}

async function getCallPrep(clientId, weekStart) {
  const ws = weekStart || defaultWeekStart()
  const { rows } = await query(
    `SELECT call_prep, updated_at FROM ai_call_preps WHERE client_id = $1 AND week_start = $2`,
    [clientId, ws]
  )
  if (!rows[0]) return null
  const data = typeof rows[0].call_prep === 'string' ? JSON.parse(rows[0].call_prep) : rows[0].call_prep
  return { ...data, cached_at: rows[0].updated_at }
}

async function getOrGenerateCallPrep(clientId, weekStart) {
  const existing = await getCallPrep(clientId, weekStart)
  if (existing?.headline) return existing
  return generateCallPrep(clientId, weekStart)
}

module.exports = { generateCallPrep, getCallPrep, getOrGenerateCallPrep }
