'use strict'

// ============================================================
// lib/semrush.js — SEMrush Analytics API client.
//
// Reads organic keyword rankings, domain overview (traffic, value,
// rank), and top organic competitors for any domain. All calls go
// to the standard Analytics API (api.semrush.com) and return CSV
// which we normalise to clean JS objects before persisting.
//
// Graceful degradation: if SEMRUSH_API_KEY is unset every function
// returns null/[] so the route layer can serve an empty-but-valid
// payload instead of a 500 — the UI then renders a "connect SEMrush"
// empty state rather than breaking.
// ============================================================

const https  = require('https')
const { query } = require('../db')

const BASE = 'https://api.semrush.com/'
const DB   = 'us'    // US database — change to 'uk', 'au', etc. if needed

function getKey() { return process.env.SEMRUSH_API_KEY || null }

// ── CSV parser ────────────────────────────────────────────────────────────────
// SEMrush returns semicolon-delimited CSV (first row = headers).
function parseCSV(text) {
  if (!text || !text.trim()) return []
  const lines = text.trim().split('\n')
  if (lines.length < 2) return []
  const headers = lines[0].split(';').map(h => h.trim())
  return lines.slice(1).map(line => {
    const vals = line.split(';')
    const obj  = {}
    headers.forEach((h, i) => { obj[h] = (vals[i] || '').trim() })
    return obj
  })
}

// ── HTTP helper ───────────────────────────────────────────────────────────────
function semrushGet(params) {
  return new Promise((resolve, reject) => {
    const key = getKey()
    if (!key) return resolve(null)
    const qs  = new URLSearchParams({ key, ...params }).toString()
    https.get(`${BASE}?${qs}`, res => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => {
        if (res.statusCode !== 200) {
          console.warn('[semrush] API error', res.statusCode, data.slice(0, 200))
          return resolve(null)
        }
        resolve(data)
      })
    }).on('error', err => {
      console.warn('[semrush] request error', err.message)
      resolve(null)
    })
  })
}

// ── Domain Overview ───────────────────────────────────────────────────────────
// Organic keywords count, estimated monthly traffic, traffic value in USD,
// and domain rank (authority proxy). Returns null when the API is unreachable
// or the key is missing.
async function getDomainOverview(domain) {
  const csv = await semrushGet({
    type:           'domain_rank',
    domain,
    database:       DB,
    export_columns: 'Dn,Rk,Or,Ot,Oc,Ad',
  })
  if (!csv) return null
  const rows = parseCSV(csv)
  if (!rows.length) return null
  const r = rows[0]
  return {
    domain:           r['Domain']             || domain,
    rank:             parseInt(r['Rank'])      || 0,
    organic_keywords: parseInt(r['Organic Keywords'])  || 0,
    organic_traffic:  parseInt(r['Organic Traffic'])   || 0,
    traffic_value:    parseFloat(r['Organic Cost'])    || 0,
    paid_keywords:    parseInt(r['Adwords Keywords'])  || 0,
  }
}

// ── Top Organic Keywords ──────────────────────────────────────────────────────
// Returns up to `limit` keyword rows sorted by ascending position (best ranks
// first). Each row: { keyword, position, volume, cpc, url, traffic_pct }.
async function getTopKeywords(domain, limit = 20) {
  const csv = await semrushGet({
    type:           'domain_organic',
    domain,
    database:       DB,
    display_limit:  String(limit),
    display_sort:   'po_asc',
    export_columns: 'Ph,Po,Nq,Cpc,Ur,Td',
  })
  if (!csv) return []
  return parseCSV(csv).map(r => ({
    keyword:     r['Keyword']        || r['Ph'] || '',
    position:    parseInt(r['Position']     || r['Po']) || 0,
    volume:      parseInt(r['Search Volume']|| r['Nq']) || 0,
    cpc:         parseFloat(r['CPC']        || r['Cpc']) || 0,
    url:         r['URL']            || r['Ur'] || '',
    traffic_pct: parseFloat(r['Traffic (%)']|| r['Td']) || 0,
  })).filter(k => k.keyword && k.position > 0)
}

// ── Organic Competitors ───────────────────────────────────────────────────────
// Domains that compete organically with this domain — sorted by common keyword
// overlap descending. Each row: { domain, common_keywords, common_pct,
// organic_keywords, organic_traffic }.
async function getCompetitors(domain, limit = 8) {
  const csv = await semrushGet({
    type:           'domain_organic_organic',
    domain,
    database:       DB,
    display_limit:  String(limit),
    export_columns: 'Dn,Cr,Np,Or,Ot',
  })
  if (!csv) return []
  return parseCSV(csv).map(r => ({
    domain:           r['Domain']                      || r['Dn'] || '',
    common_keywords:  parseInt(r['Common Keywords']    || r['Cr']) || 0,
    common_pct:       parseFloat(r['Common Keywords (%)'] || r['Np']) || 0,
    organic_keywords: parseInt(r['Organic Keywords']   || r['Or']) || 0,
    organic_traffic:  parseInt(r['Organic Traffic']    || r['Ot']) || 0,
  })).filter(c => c.domain)
}

// ── Full Domain Sync ─────────────────────────────────────────────────────────
// Fetches all three data points concurrently and upserts into semrush_snapshots.
// Returns the upserted row or null if the API key is missing.
async function syncClientSEO(clientId) {
  const key = getKey()
  if (!key) {
    console.log('[semrush] SEMRUSH_API_KEY not set — skipping SEO sync')
    return null
  }

  // Look up the client's website domain
  const { rows: clients } = await query(
    'SELECT website_domain FROM clients WHERE id = $1',
    [clientId]
  )
  const domain = clients[0]?.website_domain
  if (!domain) {
    console.log(`[semrush] no website_domain for client ${clientId} — skipping`)
    return null
  }

  // Fetch all three concurrently
  const [overview, keywords, competitors] = await Promise.all([
    getDomainOverview(domain),
    getTopKeywords(domain, 20),
    getCompetitors(domain, 8),
  ])

  if (!overview) {
    console.warn(`[semrush] domain overview returned null for ${domain}`)
    return null
  }

  // Upsert — idempotent by (client_id, snapshot_date)
  const today = new Date().toISOString().split('T')[0]
  await query(
    `INSERT INTO semrush_snapshots
       (client_id, domain, snapshot_date, organic_keywords, organic_traffic,
        traffic_value, domain_rank, top_keywords, competitors)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (client_id, snapshot_date) DO UPDATE SET
       domain           = EXCLUDED.domain,
       organic_keywords = EXCLUDED.organic_keywords,
       organic_traffic  = EXCLUDED.organic_traffic,
       traffic_value    = EXCLUDED.traffic_value,
       domain_rank      = EXCLUDED.domain_rank,
       top_keywords     = EXCLUDED.top_keywords,
       competitors      = EXCLUDED.competitors`,
    [
      clientId,
      overview.domain,
      today,
      overview.organic_keywords,
      overview.organic_traffic,
      overview.traffic_value,
      overview.rank,
      JSON.stringify(keywords),
      JSON.stringify(competitors),
    ]
  )

  return { clientId, domain: overview.domain, overview, keywordCount: keywords.length }
}

// ── Portfolio sync ────────────────────────────────────────────────────────────
// Syncs every active client that has a website_domain configured.
async function syncAllSEO() {
  const key = getKey()
  if (!key) return { skipped: true, reason: 'SEMRUSH_API_KEY not set' }

  const { rows: clients } = await query(
    `SELECT id FROM clients WHERE status = 'active' AND website_domain IS NOT NULL AND website_domain != ''`
  )

  const results = []
  for (const c of clients) {
    try {
      const r = await syncClientSEO(c.id)
      if (r) results.push({ ok: true, ...r })
    } catch (err) {
      console.error(`[semrush] sync error for ${c.id}:`, err.message)
      results.push({ ok: false, clientId: c.id, error: err.message })
    }
  }
  return { synced: results.length, results }
}

module.exports = { getDomainOverview, getTopKeywords, getCompetitors, syncClientSEO, syncAllSEO, getKey }
