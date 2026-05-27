/**
 * Seed the local SQLite DB with mock data matching the frontend mock dataset.
 * Run: node seed.js  (from api/ directory)
 * Safe to re-run: uses INSERT OR IGNORE / INSERT OR REPLACE.
 */

'use strict'

require('dotenv').config()
const { query, migrate } = require('./db')
const bcrypt = require('bcryptjs')
const crypto = require('crypto')

// ── helpers ───────────────────────────────────────────────────────────────────
function uuid() { return crypto.randomUUID() }
function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min }
function randF(min, max, dec = 1) { return parseFloat((Math.random() * (max - min) + min).toFixed(dec)) }

function monday(weeksAgo) {
  const d = new Date()
  d.setDate(d.getDate() - d.getDay() + 1 - weeksAgo * 7)
  return d.toISOString().split('T')[0]
}

// ── data ──────────────────────────────────────────────────────────────────────
const CLIENTS = [
  { name: 'Apex Roofing',        industry: 'Roofing',     location: 'Phoenix, AZ',    status: 'active' },
  { name: 'Blue Sky HVAC',        industry: 'HVAC',        location: 'Dallas, TX',     status: 'active' },
  { name: 'Cornerstone Plumbing', industry: 'Plumbing',    location: 'Denver, CO',     status: 'active' },
  { name: 'Precision Electric',   industry: 'Electrical',  location: 'Atlanta, GA',    status: 'active' },
  { name: 'Summit Solar',         industry: 'Solar',       location: 'Las Vegas, NV',  status: 'active' },
]

const seeds = {
  0: { spend: [1800, 2200], lsa_spend: [600, 900],  meta_spend: [700, 1100], calls: [25, 40], views: [1400, 1900] },
  1: { spend: [1200, 1600], lsa_spend: [400, 650],  meta_spend: [450, 800],  calls: [18, 30], views: [900, 1300]  },
  2: { spend: [800, 1100],  lsa_spend: [300, 500],  meta_spend: [300, 600],  calls: [12, 22], views: [600, 900]   },
  3: { spend: [1000, 1400], lsa_spend: [350, 550],  meta_spend: [400, 750],  calls: [15, 26], views: [750, 1100]  },
  4: { spend: [500, 900],   lsa_spend: [150, 300],  meta_spend: [200, 450],  calls: [8, 14],  views: [400, 700]   },
}

const WEEKS = Array.from({ length: 12 }, (_, i) => monday(11 - i))

async function seed() {
  console.log('[seed] running migrations…')
  await migrate()

  // ── admin user ───────────────────────────────────────────────────────────────
  const hash = await bcrypt.hash('admin', 10)
  try {
    await query(
      `INSERT INTO users (id, email, password_hash, role) VALUES (?,?,?,?)`,
      [uuid(), 'admin@example.com', hash, 'agency']
    )
    console.log('[seed] created admin@example.com / admin')
  } catch (e) {
    if (e.message.includes('UNIQUE')) console.log('[seed] admin user already exists')
    else throw e
  }

  // ── clients ───────────────────────────────────────────────────────────────────
  const clientIds = []
  for (const c of CLIENTS) {
    const id = uuid()
    try {
      await query(
        `INSERT INTO clients (id, name, industry, location, status) VALUES (?,?,?,?,?)`,
        [id, c.name, c.industry, c.location, c.status]
      )
      clientIds.push(id)
      console.log('[seed] client:', c.name)
    } catch (e) {
      if (e.message.includes('UNIQUE')) {
        // Already exists — look it up
        const { rows } = await query(`SELECT id FROM clients WHERE name = ?`, [c.name])
        clientIds.push(rows[0].id)
      } else throw e
    }
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
            raw_leads, mql, sql_count, closed_won, projected_revenue, avg_ticket
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            uuid(), clientIds[ci], week,
            ads_spend, ads_impressions, ads_clicks, ads_leads, randF(3.0, 6.5),
            lsa_spend, lsa_calls, lsa_booked,
            meta_spend, meta_impressions, meta_clicks, meta_leads, randF(2.5, 5.5),
            gbp_views, gbp_searches, gbp_calls, gbp_directions, gbp_website,
            ga4_sessions, ga4_new_users, ga4_organic_sessions, ga4_paid_sessions,
            ga4_direct_sessions, ga4_conversions, ga4_engagement_rate,
            raw_leads, mql, sql_val, closed_won, closed_won * avg_ticket, avg_ticket,
          ]
        )
        inserted++
      } catch (e) {
        if (!e.message.includes('UNIQUE')) throw e
      }
    }
  }
  console.log(`[seed] inserted ${inserted} weekly reports`)

  // ── agency settings ───────────────────────────────────────────────────────────
  await query(
    `INSERT OR IGNORE INTO agency_settings (id, agency_name, accent_hex) VALUES (1, '10X Performance', '#e53935')`
  )

  console.log('[seed] ✅ done — login: admin@example.com / admin')
  process.exit(0)
}

seed().catch(err => { console.error('[seed]', err.message); process.exit(1) })
