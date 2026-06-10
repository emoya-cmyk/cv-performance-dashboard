/**
 * Seed the local SQLite DB with mock data matching the frontend mock dataset.
 * Run: node seed.js  (from api/ directory)
 * Safe to re-run: uses INSERT OR IGNORE / INSERT OR REPLACE.
 */

'use strict'

require('dotenv').config()
const { query, migrate } = require('./db')
const facts = require('./lib/facts')   // column→fact adapter (powers the defect-C atomic-grain seed)
const bcrypt = require('bcryptjs')
const crypto = require('crypto')

// ── helpers ───────────────────────────────────────────────────────────────────
function uuid() { return crypto.randomUUID() }
function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min }
function randF(min, max, dec = 1) { return parseFloat((Math.random() * (max - min) + min).toFixed(dec)) }

function monday(weeksAgo) {
  // UTC-anchored so the demo week_start can never drift by the host timezone and
  // always equals rollup.js weekStartOf() (the Monday of the ISO week). The previous
  // LOCAL-time computation is exactly what let a reseed on a different calendar day
  // anchor on a neighbouring weekday, leaving a second, day-offset 12-week series
  // behind that INSERT OR IGNORE keyed on (client_id, week_start) could never dedupe.
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  const day = d.getUTCDay()                                  // 0=Sun … 6=Sat
  d.setUTCDate(d.getUTCDate() + ((day === 0 ? -6 : 1) - day) - weeksAgo * 7)
  return d.toISOString().slice(0, 10)
}

// ── fact_metric daily-grain spreader (defect C) ────────────────────────────────
// /explore and the intra-week "Daily Pulse" read the atomic fact_metric grain, which
// the seed never populated → both surfaces showed empty. We backfill it FROM the same
// weekly_reports rows, through the SAME column→fact adapter the rollup/golden-parity
// path uses, then spread each weekly fact across its 7 days. The split is exact: the
// 7 daily values sum back to the weekly total (last day absorbs the rounding
// remainder) and rate metrics are replicated (their weekly AVG is unchanged). Net
// invariant: rebuildWeeklyRollup(fact_metric) === weekly_reports — the two data paths
// are provably in agreement, so nothing can drift dirty.
const DOW_WEIGHTS = [0.92, 1.04, 1.10, 1.12, 1.16, 0.94, 0.72]   // index 0 = Monday → realistic mid-week lift, lighter weekends
const DOW_TOTAL   = DOW_WEIGHTS.reduce((a, b) => a + b, 0)

// Period-average metrics must be REPLICATED across the week, never split — the weekly
// AVG over 7 identical days equals the stored value. Derived from the column map so it
// can never drift out of sync with facts.js.
// COLUMN_FACT_MAP is flat: column-name → descriptor { channel, metric_key, agg? }.
const AVG_METRIC_KEYS = new Set(
  Object.values(facts.COLUMN_FACT_MAP)
    .filter(d => d && d.agg === 'avg')
    .map(d => d.metric_key)
)
// Money metrics carry 2-decimal precision; every other metric is an integer count.
const CURRENCY_METRIC_KEYS = new Set(['spend', 'revenue', 'projected_revenue'])

function addDaysISO(iso, n) {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const round2 = n => Math.round(n * 100) / 100

// One weekly account-grain fact → 7 daily facts that reconstruct it exactly.
function spreadFactAcrossWeek(f) {
  const out = []
  if (AVG_METRIC_KEYS.has(f.metric_key)) {
    for (let i = 0; i < 7; i++) out.push({ date: addDaysISO(f.date, i), value: f.value })
    return out
  }
  const isMoney = CURRENCY_METRIC_KEYS.has(f.metric_key)
  let acc = 0
  for (let i = 0; i < 7; i++) {
    let v
    if (i < 6) {
      const raw = f.value * DOW_WEIGHTS[i] / DOW_TOTAL
      v = isMoney ? round2(raw) : Math.round(raw)
    } else {
      v = isMoney ? round2(f.value - acc) : (f.value - acc)   // last day = exact remainder → Σ is exact
    }
    acc += v
    out.push({ date: addDaysISO(f.date, i), value: v })
  }
  return out
}

// ── data ──────────────────────────────────────────────────────────────────────
const CLIENTS = [
  { name: 'Apex Roofing',        industry: 'Roofing',     location: 'Phoenix, AZ',    status: 'active', am_owner: 'Sarah K.'  },
  { name: 'Blue Sky HVAC',        industry: 'HVAC',        location: 'Dallas, TX',     status: 'active', am_owner: 'Mike T.'   },
  { name: 'Cornerstone Plumbing', industry: 'Plumbing',    location: 'Denver, CO',     status: 'active', am_owner: 'Sarah K.'  },
  { name: 'Precision Electric',   industry: 'Electrical',  location: 'Atlanta, GA',    status: 'active', am_owner: 'Jordan R.' },
  { name: 'Summit Solar',         industry: 'Solar',       location: 'Las Vegas, NV',  status: 'active', am_owner: 'Mike T.'   },
]

const seeds = {
  // Spend ranges are revenue-basis calibrated: with home-services avg tickets
  // ($2.8k–6.5k) and realistic close rates, CPL lands in the $45–80 industry band
  // and blended revenue-ROAS lands ~10–15× (NOT the 3–5× ad-platform-reported basis).
  0: { spend: [3600, 4400], lsa_spend: [1200, 1800], meta_spend: [1400, 2200], calls: [25, 40], views: [1400, 1900] },
  1: { spend: [2400, 3200], lsa_spend: [800, 1300],  meta_spend: [900, 1600],  calls: [18, 30], views: [900, 1300]  },
  2: { spend: [1600, 2200], lsa_spend: [600, 1000],  meta_spend: [600, 1200],  calls: [12, 22], views: [600, 900]   },
  3: { spend: [2000, 2800], lsa_spend: [700, 1100],  meta_spend: [800, 1500],  calls: [15, 26], views: [750, 1100]  },
  4: { spend: [1000, 1800], lsa_spend: [300, 600],   meta_spend: [400, 900],   calls: [8, 14],  views: [400, 700]   },
}

const WEEKS = Array.from({ length: 12 }, (_, i) => monday(11 - i))

// Standalone, idempotent admin-user upsert.
// Called unconditionally on every serverless cold-start (server.js) so the
// admin password is always correct even when the clients gate (count === 0)
// has already been cleared by a prior full seed run.
async function ensureAdmin () {
  const hash = await bcrypt.hash('admin', 10)
  // ON CONFLICT DO UPDATE is safe even on the very first boot — it just
  // becomes a plain INSERT on a fresh DB and an UPDATE on any subsequent one.
  await query(
    `INSERT INTO users (id, email, password_hash, role)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           role          = EXCLUDED.role`,
    [uuid(), 'admin@example.com', hash, 'agency']
  )
  console.log('[seed] admin@example.com upserted — login: admin@example.com / admin')
}

async function seed() {
  console.log('[seed] running migrations…')
  await migrate()

  // ── admin user ───────────────────────────────────────────────────────────────
  await ensureAdmin()

  // ── clients ───────────────────────────────────────────────────────────────────
  const clientIds = []
  for (const c of CLIENTS) {
    // Idempotent by name: the clients table has no UNIQUE(name) constraint, so we
    // must look for an existing row rather than rely on catching a UNIQUE error —
    // otherwise every re-run silently duplicates the entire portfolio.
    const existing = await query(`SELECT id FROM clients WHERE name = $1 LIMIT 1`, [c.name])
    if (existing.rows.length) {
      clientIds.push(existing.rows[0].id)
      await query(`UPDATE clients SET am_owner = $1 WHERE id = $2`, [c.am_owner, existing.rows[0].id])
      console.log('[seed] client exists:', c.name)
      continue
    }
    const id = uuid()
    await query(
      `INSERT INTO clients (id, name, industry, location, status, am_owner) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, c.name, c.industry, c.location, c.status, c.am_owner]
    )
    clientIds.push(id)
    console.log('[seed] client:', c.name)
  }

  // ── weekly reports ────────────────────────────────────────────────────────────
  let inserted = 0
  for (let ci = 0; ci < clientIds.length; ci++) {
    const s = seeds[ci]
    for (const week of WEEKS) {
      const ads_spend       = rand(...s.spend)
      const lsa_spend       = rand(...s.lsa_spend)
      const meta_spend      = rand(...s.meta_spend)
      const ads_clicks      = rand(180, 420)
      const ads_impressions = rand(5000, 12000)
      const meta_clicks     = rand(120, 350)
      const meta_impressions = rand(8000, 22000)
      const lsa_calls       = rand(...s.calls)
      const lsa_booked      = Math.round(lsa_calls * randF(0.35, 0.55))
      const ads_leads       = rand(15, 45)
      const meta_leads      = rand(8, 28)
      const gbp_views       = rand(...s.views)
      const gbp_searches    = Math.round(gbp_views * randF(0.55, 0.75))
      const gbp_calls       = rand(20, 60)
      const gbp_directions  = rand(10, 35)
      const gbp_website     = rand(30, 90)
      const raw_leads       = ads_leads + lsa_calls + meta_leads + Math.round(gbp_calls * 0.4)
      const mql             = Math.round(raw_leads * randF(0.45, 0.60))
      const sql_val         = Math.round(mql * randF(0.35, 0.50))
      const closed_won      = Math.round(sql_val * randF(0.55, 0.75))
      // Appointments booked beyond the LSA channel (web forms, phone, chat).
      // Total booked is pinned ABOVE closed_won at a realistic 50–65% appt→close
      // rate so the lead funnel narrows monotonically — you can never win more
      // jobs than you booked. Clamping at 0 only ever makes booked LARGER, so
      // booked > closed_won holds every week and therefore in aggregate.
      const appt_close_rate = randF(0.50, 0.65)
      const total_booked    = Math.round(closed_won / appt_close_rate)
      const appointments    = Math.max(0, total_booked - lsa_booked)
      const avg_ticket      = rand(2800, 6500)

      // GA4 fields
      const ga4_sessions         = rand(200, 1500)
      const ga4_new_users        = Math.round(ga4_sessions * randF(0.55, 0.65))
      const ga4_organic_sessions = Math.round(ga4_sessions * randF(0.35, 0.45))
      const ga4_paid_sessions    = Math.round(ga4_sessions * randF(0.20, 0.30))
      const ga4_direct_sessions  = Math.round(ga4_sessions * randF(0.15, 0.25))
      const ga4_conversions      = Math.round(ga4_sessions * randF(0.02, 0.04))
      const ga4_engagement_rate  = randF(50, 75)

      try {
        await query(`
          INSERT OR IGNORE INTO weekly_reports (
            id, client_id, week_start,
            ads_spend, ads_impressions, ads_clicks, ads_leads, ads_roas,
            lsa_spend, lsa_calls, lsa_booked_jobs,
            meta_spend, meta_impressions, meta_clicks, meta_leads, meta_roas,
            gbp_views, gbp_searches, gbp_calls, gbp_directions, gbp_website_clicks,
            ga4_sessions, ga4_new_users, ga4_organic_sessions, ga4_paid_sessions,
            ga4_direct_sessions, ga4_conversions, ga4_engagement_rate,
            raw_leads, mql, sql_count, closed_won, projected_revenue, avg_ticket, appointments
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35)`,
          [
            uuid(), clientIds[ci], week,
            ads_spend, ads_impressions, ads_clicks, ads_leads, randF(3.0, 6.5),
            lsa_spend, lsa_calls, lsa_booked,
            meta_spend, meta_impressions, meta_clicks, meta_leads, randF(2.5, 5.5),
            gbp_views, gbp_searches, gbp_calls, gbp_directions, gbp_website,
            ga4_sessions, ga4_new_users, ga4_organic_sessions, ga4_paid_sessions,
            ga4_direct_sessions, ga4_conversions, ga4_engagement_rate,
            raw_leads, mql, sql_val, closed_won, closed_won * avg_ticket, avg_ticket, appointments,
          ]
        )
        inserted++
      } catch (e) {
        if (!e.message.includes('UNIQUE')) throw e
      }
    }
  }
  console.log(`[seed] inserted ${inserted} weekly reports`)

  // ── self-healing convergence (data hygiene) ────────────────────────────────────
  // A reseed under the OLD local-time monday() (or any future code/date drift) could
  // leave a second, day-offset 12-week series in weekly_reports that INSERT OR IGNORE,
  // keyed on (client_id, week_start), can never dedupe — the two overlapping daily
  // spreads then collapse fact_metric to a last-writer mess and break the
  // rebuildWeeklyRollup(fact_metric) === weekly_reports invariant. Converge to the
  // canonical window: prune any demo-client weekly row OUTSIDE the current 12 Mondays,
  // then clear demo-client facts so the block below rebuilds them as an exact
  // projection of the now-clean wide table. Scoped to the 5 demo client IDs so a real
  // deployment's connector-sourced data for any other client is never touched.
  if (clientIds.length) {
    const cph = clientIds.map((_, i) => `$${i + 1}`).join(',')
    const wph = WEEKS.map((_, i) => `$${clientIds.length + i + 1}`).join(',')
    const pruned = await query(
      `DELETE FROM weekly_reports WHERE client_id IN (${cph}) AND week_start NOT IN (${wph})`,
      [...clientIds, ...WEEKS]
    )
    if (pruned.rowCount) {
      console.log(`[seed] pruned ${pruned.rowCount} out-of-window weekly row(s) — converged to the canonical 12-week window`)
    }
    const clearedFacts = await query(`DELETE FROM fact_metric WHERE client_id IN (${cph})`, clientIds)
    if (clearedFacts.rowCount) {
      console.log(`[seed] cleared ${clearedFacts.rowCount} demo fact_metric row(s) for clean rebuild`)
    }
  }

  // ── fact_metric atomic grain (defect C) ────────────────────────────────────────
  // Powers /explore and the intra-week Daily Pulse. Built FROM the weekly rows we just
  // wrote — read them straight back so the grain can never disagree with the wide
  // table — then expand each weekly fact to a daily series that rolls back up exactly.
  // INSERT OR REPLACE keyed on (client_id, date, channel_id, entity_id, metric_key)
  // makes every re-seed self-heal the grain rather than duplicate it.
  const { rows: wrRows } = await query(`SELECT * FROM weekly_reports ORDER BY client_id, week_start`)
  const factTuples = []
  for (const wr of wrRows) {
    for (const wf of facts.factsFromWeeklyRow(wr)) {
      const channel_id = facts.channelId(wf.channel)
      if (!channel_id) continue
      for (const day of spreadFactAcrossWeek(wf)) {
        if (day.value == null || !Number.isFinite(Number(day.value))) continue
        // entity_id = null → account grain (matches factsFromWeeklyRow + the ux_fact_grain index)
        factTuples.push([wr.client_id, day.date, channel_id, null, wf.metric_key, Number(day.value)])
      }
    }
  }
  // Chunked multi-row upsert: better-sqlite3 rejects BEGIN/COMMIT via prepare() and
  // db-sqlite exposes no transaction helper, so we batch 100 rows × 6 cols = 600 bound
  // params per statement — comfortably under SQLite's 999-variable cap.
  let factRows = 0
  const FACT_CHUNK = 100
  for (let i = 0; i < factTuples.length; i += FACT_CHUNK) {
    const slice = factTuples.slice(i, i + FACT_CHUNK)
    const placeholders = slice
      .map((_, r) => `($${r * 6 + 1},$${r * 6 + 2},$${r * 6 + 3},$${r * 6 + 4},$${r * 6 + 5},$${r * 6 + 6})`)
      .join(',')
    await query(
      `INSERT OR REPLACE INTO fact_metric
         (client_id, date, channel_id, entity_id, metric_key, metric_value)
       VALUES ${placeholders}`,
      slice.flat()
    )
    factRows += slice.length
  }
  console.log(`[seed] inserted ${factRows} fact_metric rows (daily atomic grain from ${wrRows.length} weekly rows)`)

  // ── channel 8-11 direct fact_metric seeds (callrail/hcp/bing/youtube) ─────────
  // These channels have no weekly_reports columns so factsFromWeeklyRow never
  // produces facts for them. Insert directly using DOW spreading + chunked upsert.
  function arcMult(arc, wi) {
    if (arc === 'recovery') return 0.55 + wi * 0.04
    if (arc === 'growth')   return 0.70 + wi * 0.026
    if (arc === 'steady')   return 0.90 + (wi % 3) * 0.03
    if (arc === 'early')    return 0.35 + wi * 0.055
    return 1
  }
  // [callrail, hcp, bing, youtube] arc per client (CLIENTS order)
  const CH_ARCS = [
    ['growth',   'growth',   'steady',   'early'],    // 0 Apex Roofing
    ['steady',   'recovery', 'early',    'growth'],   // 1 Blue Sky HVAC
    ['growth',   'growth',   'steady',   'steady'],   // 2 Cornerstone Plumbing
    ['recovery', 'early',    'recovery', 'early'],    // 3 Precision Electric
    ['early',    'steady',   'growth',   'growth'],   // 4 Summit Solar
  ]
  const newChTuples = []
  for (let ci = 0; ci < clientIds.length; ci++) {
    const [crArc, hcpArc, bingArc, ytArc] = CH_ARCS[ci]
    for (let wi = 0; wi < WEEKS.length; wi++) {
      const week = WEEKS[wi]
      const crM  = arcMult(crArc,  wi)
      const hcpM = arcMult(hcpArc, wi)
      const bM   = arcMult(bingArc, wi)
      const ytM  = arcMult(ytArc,  wi)

      // CallRail (channel 8)
      const crCalls  = Math.max(1, Math.round(rand(30, 65) * crM))
      const crAns    = Math.round(crCalls * randF(0.74, 0.84))
      const crMissed = crCalls - crAns
      const crFirst  = Math.round(crCalls * randF(0.38, 0.52))
      for (const [key, val] of [
        ['calls', crCalls], ['answered_calls', crAns],
        ['missed_calls', crMissed], ['first_time_callers', crFirst],
      ]) {
        for (const day of spreadFactAcrossWeek({ date: week, metric_key: key, value: val })) {
          if (day.value == null || !Number.isFinite(Number(day.value))) continue
          newChTuples.push([clientIds[ci], day.date, 8, null, key, Number(day.value)])
        }
      }

      // HouseCallPro (channel 9)
      const hcpJobs   = Math.max(1, Math.round(rand(8, 22) * hcpM))
      const hcpComp   = Math.round(hcpJobs * randF(0.82, 0.92))
      const hcpTicket = rand(2800, 6500)
      const hcpRev    = hcpComp * hcpTicket
      const hcpBooked = Math.round(hcpJobs * randF(0.85, 0.96))
      for (const [key, val] of [
        ['jobs_created', hcpJobs], ['jobs_completed', hcpComp],
        ['job_revenue', hcpRev], ['avg_ticket', hcpTicket], ['booked_jobs', hcpBooked],
      ]) {
        for (const day of spreadFactAcrossWeek({ date: week, metric_key: key, value: val })) {
          if (day.value == null || !Number.isFinite(Number(day.value))) continue
          newChTuples.push([clientIds[ci], day.date, 9, null, key, Number(day.value)])
        }
      }

      // Bing Ads (channel 10)
      const bSpend  = round2(Math.max(1, Math.round(rand(500, 1400) * bM)))
      const bImpr   = Math.max(1, Math.round(rand(3000, 9000) * bM))
      const bClicks = Math.max(1, Math.round(rand(50, 180) * bM))
      const bConv   = Math.max(0, Math.round(rand(3, 15) * bM))
      const bRev    = round2(bConv * rand(2800, 6500))
      for (const [key, val] of [
        ['spend', bSpend], ['impressions', bImpr], ['clicks', bClicks],
        ['conversions', bConv], ['revenue', bRev],
      ]) {
        for (const day of spreadFactAcrossWeek({ date: week, metric_key: key, value: val })) {
          if (day.value == null || !Number.isFinite(Number(day.value))) continue
          newChTuples.push([clientIds[ci], day.date, 10, null, key, Number(day.value)])
        }
      }

      // YouTube (channel 11)
      const ytViews = Math.max(1, Math.round(rand(600, 3500) * ytM))
      const ytWatch = Math.round(ytViews * randF(3, 8))
      const ytSubs  = Math.max(0, Math.round(rand(2, 12) * ytM))
      const ytClk   = Math.max(1, Math.round(rand(15, 60) * ytM))
      const ytImpr  = Math.round(ytViews * randF(1.5, 2.5))
      for (const [key, val] of [
        ['views', ytViews], ['watch_time', ytWatch], ['subscriptions', ytSubs],
        ['clicks', ytClk], ['impressions', ytImpr],
      ]) {
        for (const day of spreadFactAcrossWeek({ date: week, metric_key: key, value: val })) {
          if (day.value == null || !Number.isFinite(Number(day.value))) continue
          newChTuples.push([clientIds[ci], day.date, 11, null, key, Number(day.value)])
        }
      }
    }
  }
  let newChRows = 0
  for (let i = 0; i < newChTuples.length; i += FACT_CHUNK) {
    const slice = newChTuples.slice(i, i + FACT_CHUNK)
    const placeholders = slice
      .map((_, r) => `($${r * 6 + 1},$${r * 6 + 2},$${r * 6 + 3},$${r * 6 + 4},$${r * 6 + 5},$${r * 6 + 6})`)
      .join(',')
    await query(
      `INSERT OR REPLACE INTO fact_metric
         (client_id, date, channel_id, entity_id, metric_key, metric_value)
       VALUES ${placeholders}`,
      slice.flat()
    )
    newChRows += slice.length
  }
  console.log(`[seed] inserted ${newChRows} new-channel fact_metric rows (channels 8-11: callrail/hcp/bing/youtube)`)

  // ── agency settings ───────────────────────────────────────────────────────────
  await query(
    `INSERT OR IGNORE INTO agency_settings (id, agency_name, accent_hex) VALUES (1, '10X Performance', '#e53935')`
  )

  // ── per-client monthly goals (lights up forecast + pacing for defect D) ─────────
  // The forecast/pacing engine only speaks when a client has a goal for the current
  // month (loadGoal → null ⇒ the surface stays dark). Seed deliberately varied,
  // realistic targets for THIS month so /intelligence opens with a genuine worst-first
  // roster instead of an empty forecast. Each target is sized against that client's OWN
  // measured month-end projection (engine math: mtd + Holt weekly-rate × remaining-weeks)
  // so the resulting pct-of-goal lands in a chosen severity band — nothing is hand-faked;
  // runInsightsForAll() below recomputes every call from the same seeded data. The month
  // key matches monthBounds(today).monthFirst, and the upsert is idempotent on
  // (client_id, month) so a re-seed converges the targets in place.
  const goalMonth = new Date().toISOString().slice(0, 7) + '-01'   // 'YYYY-MM-01'
  // Indexed in CLIENTS order. ratio = projected ÷ target → band:
  //   <0.7 critical · 0.7–0.9 behind(warning) · 0.9–1.1 on-track(silent) · ≥1.1 ahead(info)
  const GOAL_TARGETS = [
    { revenue: 247000, leads: 475, jobs: 58 },  // 0 Apex Roofing        — ahead / on-track / ahead
    { revenue: 258000, leads: 455, jobs: 78 },  // 1 Blue Sky HVAC       — behind / on-track / behind
    { revenue: 341000, leads: 340, jobs: 55 },  // 2 Cornerstone Plumbing — ahead / on-track / ahead
    { revenue: 288000, leads: 515, jobs: 95 },  // 3 Precision Electric  — critical / behind / critical
    { revenue: 240000, leads: 345, jobs: 65 },  // 4 Summit Solar        — behind / on-track / behind
  ]
  let goalRows = 0
  for (let ci = 0; ci < clientIds.length; ci++) {
    const g = GOAL_TARGETS[ci]
    if (!g) continue
    await query(
      `INSERT INTO client_goals (client_id, month, revenue_target, leads_target, jobs_target)
         VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (client_id, month) DO UPDATE SET
         revenue_target = excluded.revenue_target,
         leads_target   = excluded.leads_target,
         jobs_target    = excluded.jobs_target,
         updated_at     = datetime('now')`,
      [clientIds[ci], goalMonth, g.revenue, g.leads, g.jobs]
    )
    goalRows++
  }
  console.log(`[seed] upserted ${goalRows} client_goals for ${goalMonth} (forecast/pacing light-up)`)

  // ── autonomy heartbeat ledger (ops-v1) ──────────────────────────────────────────
  // The job_heartbeats ledger (020) records one row per scheduled run so opsHealth.js
  // can PROVE the self-healing engine is alive and on-cadence (GET /api/insights/ops →
  // the agency OpsHealthStrip). On a fresh DB the ledger is empty, so the strip honestly
  // reads "warming up" — correct, but it shows none of the live machinery. Seed a recent,
  // internally-consistent run history so the live preview proves the value: overall LIVE,
  // 4/4 job-classes on cadence, and the watchdog's self-heals totalled for the week.
  // Nothing here is hand-faked grading — assessOps recomputes the status from these exact
  // ran_at ages on every request; we only supply realistic rows. Idempotent: every seeded
  // row is tagged detail.seed=true and purged first, so a re-seed converges in place and
  // NEVER touches a real scheduler-written heartbeat (which carries no seed tag).
  //
  // Ages sit well inside each job's live grace window (opsHealth GRACE=1.5×cadence ⇒
  // watchdog 22.5m, sync 9h, insights 36h, digest 10.5d) so the demo grades green. The
  // watchdog's short cadence is the binding constraint — and its freshest beat leads the
  // "last run … ago" line — so it is seeded only minutes old for headroom after re-seed.
  try {
    const hbAgo = (minsAgo) => new Date(Date.now() - minsAgo * 60000).toISOString()
    // [job, status, minutesAgo, duration_ms, detail] — detail is machine counters only
    // (never PII); detail.healed on watchdog rows is exactly what countHeals totals.
    const HEARTBEATS = [
      // latest run per job-class — the four assessOps grades for "on cadence"
      ['watchdog', 'success',    3,  1180, { scanned: 11, healed: 0 }],
      ['sync',     'success',   90, 42120, { clients: 5, channels: 11, synced: 11, failed: 0 }],
      ['insights', 'success',  300,  8230, { clients: 5, swept: 5, findings: 12, snapshots: 5 }],
      ['digest',   'success', 2880,  5110, { recipients: 5, sent: 5, failed: 0 }],
      // trailing watchdog history — supplies the "N self-heals this week" total
      // (Σ healed = 1 + 2 + 1 = 4, every row inside the 7-day heal window)
      ['watchdog', 'success',  312,  1210, { scanned: 11, healed: 1, reauthed: ['google_ads'] }],
      ['watchdog', 'success', 1083,  1090, { scanned: 11, healed: 0 }],
      ['watchdog', 'success', 1722,  1340, { scanned: 12, healed: 2, reauthed: ['meta_ads', 'lsa'] }],
      ['watchdog', 'success', 4323,  1015, { scanned: 10, healed: 1, reauthed: ['gbp'] }],
      ['watchdog', 'success', 8643,   980, { scanned: 9, healed: 0 }],
    ]
    await query(`DELETE FROM job_heartbeats WHERE detail LIKE '%"seed":true%'`)
    let hbRows = 0
    for (const [job, status, minsAgo, durationMs, detail] of HEARTBEATS) {
      await query(
        `INSERT INTO job_heartbeats (job, status, ran_at, duration_ms, detail)
           VALUES ($1,$2,$3,$4,$5)`,
        [job, status, hbAgo(minsAgo), durationMs, JSON.stringify({ ...detail, seed: true })]
      )
      hbRows++
    }
    console.log(`[seed] seeded ${hbRows} job_heartbeats (autonomy ledger → ops LIVE · 4/4 · 4 self-heals)`)
  } catch (e) {
    console.warn('[seed] job_heartbeats seed skipped:', e.message)
  }

  // ── intelligence layer (defect D) ──────────────────────────────────────────────
  // The insights table seeds empty, so /intelligence and the per-client insight feed
  // opened blank on a fresh DB. Rather than hand-fake rows, run the REAL nightly sweep
  // once — the same engine scheduler.js runs — against the data we just seeded, so the
  // findings are genuine and internally consistent (and the daily grain from defect C
  // gives coverage detection real freshness to read). Best-effort: a thin-data client
  // must never fail the whole seed.
  try {
    const { runInsightsForAll } = require('./lib/insights')
    console.log('[seed] running intelligence sweep…')
    const r = await runInsightsForAll()
    console.log(`[seed] insights sweep — swept ${r.swept}/${r.clients} clients, ${r.findings} findings, ${r.snapshotted} health snapshots`)
    if (r.failed) console.warn(`[seed] insights sweep — ${r.failed} client(s) errored:`, (r.errors || []).map(e => `${e.client_id}: ${e.error}`).join('; '))
  } catch (e) {
    console.warn('[seed] insights sweep skipped:', e.message)
  }

  console.log('[seed] ✅ done — login: admin@example.com / admin')
}

// Export so server.js can call both on cold-start:
//   ensureAdmin() — unconditionally on every cold-start (safe upsert)
//   seed()        — only when DB is empty (gated on clients count)
// When invoked directly (node seed.js), still exits cleanly.
module.exports = { seed, ensureAdmin }
if (require.main === module) {
  seed().catch(err => { console.error('[seed]', err.message); process.exit(1) })
}
