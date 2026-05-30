// ============================================================
// lib/rollup.js — derive the wide weekly_reports rows from fact_metric.
//
// Phase 0 keeps weekly_reports (and therefore metrics.js, reports.js, and the
// whole current frontend) working unchanged: after a connector lands atomic
// facts, we pivot them back into the legacy weekly columns here.
//
// Design guarantees that make this safe to run alongside the legacy
// fetchStats path during the per-connector migration:
//   • COLUMN-SCOPED — only the columns belonging to the channels that were just
//     ingested are touched. Connectors still on fetchStats keep ownership of
//     their own columns.
//   • SAME SMART-UPSERT GUARD as routes/sync.js — never overwrite a non-zero
//     value with zero — so behaviour matches the legacy path exactly.
//   • Writes only columns present on BOTH Postgres and SQLite (enforced by the
//     COLUMN_FACT_MAP in lib/facts.js).
//   • CURRENT_TIMESTAMP, not NOW(), so it is portable to SQLite.
// ============================================================

const { query } = require('../db')
const facts     = require('./facts')

// Monday (UTC) of the week containing an ISO 'YYYY-MM-DD' date.
function weekStartOf(dateStr) {
  const d   = new Date(dateStr + 'T00:00:00Z')
  const day = d.getUTCDay()
  d.setUTCDate(d.getUTCDate() + ((day === 0 ? -6 : 1) - day))
  return d.toISOString().split('T')[0]
}

// Sunday (UTC) that closes a Monday-started week.
function weekEndOf(weekStart) {
  const d = new Date(weekStart + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + 6)
  return d.toISOString().split('T')[0]
}

const round2 = (n) => Math.round(n * 100) / 100

// Column-scoped smart upsert into weekly_reports for one (client, week).
async function upsertWeekly(clientId, weekStart, vals) {
  const cols = Object.keys(vals)
  if (!cols.length) return
  const sets = cols.map(
    c => `${c} = CASE WHEN EXCLUDED.${c} > 0 THEN EXCLUDED.${c} ELSE weekly_reports.${c} END`
  )
  await query(
    `INSERT INTO weekly_reports (client_id, week_start, ${cols.join(', ')})
     VALUES ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(', ')})
     ON CONFLICT (client_id, week_start) DO UPDATE SET
       ${sets.join(',\n       ')},
       updated_at = CURRENT_TIMESTAMP`,
    [clientId, weekStart, ...cols.map(c => vals[c])]
  )
}

// Rebuild weekly_reports columns for the given client + weeks + channels from
// fact_metric. `weeks` is an array of Monday 'YYYY-MM-DD' strings; `channelKeys`
// names which channels (and therefore which columns) to recompute.
async function rebuildWeeklyRollup(clientId, weeks, channelKeys) {
  const uniqWeeks    = [...new Set(weeks || [])]
  const uniqChannels = [...new Set(channelKeys || [])]
  if (!uniqWeeks.length || !uniqChannels.length) return { weeks: 0, columns: 0 }

  const channelIds = uniqChannels.map(facts.channelId).filter(Boolean)
  const colDefs    = uniqChannels.flatMap(facts.columnsForChannel)
  if (!channelIds.length || !colDefs.length) return { weeks: 0, columns: 0 }

  for (const week of uniqWeeks) {
    const wkEnd = weekEndOf(week)

    // One grouped read of this week's facts for the affected channels.
    const { rows } = await query(
      `SELECT channel_id, metric_key,
              SUM(metric_value) AS sum_v,
              AVG(metric_value) AS avg_v
         FROM fact_metric
        WHERE client_id = $1
          AND date >= $2 AND date <= $3
          AND channel_id IN (${channelIds.map((_, i) => `$${i + 4}`).join(', ')})
        GROUP BY channel_id, metric_key`,
      [clientId, week, wkEnd, ...channelIds]
    )

    // agg[channel_id][metric_key] = { sum, avg }
    const agg = {}
    for (const r of rows) {
      ;(agg[r.channel_id] ||= {})[r.metric_key] = {
        sum: Number(r.sum_v) || 0,
        avg: r.avg_v == null ? null : Number(r.avg_v),
      }
    }

    const vals = {}
    for (const d of colDefs) {
      const bucket = agg[facts.channelId(d.channel)] || {}
      if (d.agg === 'ratio') {
        const num = bucket[d.num]?.sum || 0
        const den = bucket[d.den]?.sum || 0
        vals[d.col] = den > 0 ? round2(num / den) : 0
      } else if (d.agg === 'avg') {
        const a = bucket[d.metric_key]?.avg
        vals[d.col] = a == null ? 0 : round2(a)
      } else {
        vals[d.col] = bucket[d.metric_key]?.sum || 0
      }
    }

    await upsertWeekly(clientId, week, vals)
  }

  return { weeks: uniqWeeks.length, columns: colDefs.length }
}

module.exports = { rebuildWeeklyRollup, weekStartOf, weekEndOf }
