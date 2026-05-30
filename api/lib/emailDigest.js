/**
 * Weekly Performance Digest
 * Uses Resend (https://resend.com) — set RESEND_API_KEY in env.
 * FROM address: set DIGEST_FROM env var (e.g. "10X Dashboard <hi@youragency.com>")
 */

const { Resend } = require('resend')

const resend  = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null
const FROM    = process.env.DIGEST_FROM    || '10X Dashboard <noreply@10xmarketing.com>'
const BASE_URL = process.env.APP_URL       || 'https://performance-dashboard-ke5c.onrender.com'

// ── Formatters ────────────────────────────────────────────────────────────────
function fmt$(n) {
  if (!n || n === 0) return '$0'
  if (n >= 1_000_000) return `$${(n/1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `$${(n/1_000).toFixed(1)}K`
  return `$${Math.round(n).toLocaleString()}`
}
function fmtX(n)   { return n ? `${(+n).toFixed(1)}×` : '—' }
function fmtN(n)   { return n ? (+n).toLocaleString() : '0' }

// Minimal HTML-escape for interpolated dynamic copy. The AI recap is
// machine-generated narration, so escape it before it lands in the template.
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function pctLabel(curr, prev) {
  if (!prev || prev === 0) return null
  const p = ((curr - prev) / prev) * 100
  return p >= 0 ? `↑ ${Math.abs(p).toFixed(0)}%` : `↓ ${Math.abs(p).toFixed(0)}%`
}

function dateRange(weeksBack = 1) {
  const end   = new Date(); end.setUTCDate(end.getUTCDate() - 1)
  const start = new Date(); start.setUTCDate(start.getUTCDate() - weeksBack * 7)
  const opts  = { month: 'short', day: 'numeric' }
  return `${start.toLocaleDateString('en-US', opts)} – ${end.toLocaleDateString('en-US', opts)}`
}

// ── HTML Email Template ───────────────────────────────────────────────────────
function buildHtml({ client, stats, prevStats, goal, update, recap, unsubToken }) {
  const rev      = stats.total_revenue || 0
  const jobs     = stats.total_closed  || 0
  const roas     = stats.roas          || 0
  const leads    = stats.total_leads   || 0

  const revLabel  = pctLabel(rev,  prevStats?.total_revenue)
  const jobLabel  = pctLabel(jobs, prevStats?.total_closed)

  const dashUrl   = `${BASE_URL}/my-dashboard`
  const unsubUrl  = `${BASE_URL}/api/unsubscribe/${unsubToken}`

  // Goal progress bar (if set)
  const goalHtml = goal?.revenue_target > 0 ? (() => {
    const pct = Math.min(Math.round((rev / goal.revenue_target) * 100), 100)
    const color = pct >= 80 ? '#10b981' : pct >= 50 ? '#f59e0b' : '#e53935'
    return `
      <table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0 0;">
        <tr><td>
          <p style="margin:0 0 6px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#94a3b8;">Monthly Goal Progress</p>
          <div style="background:#f1f5f9;border-radius:6px;height:8px;overflow:hidden;">
            <div style="background:${color};height:8px;width:${pct}%;border-radius:6px;"></div>
          </div>
          <p style="margin:4px 0 0;font-size:11px;color:#64748b;">
            <strong style="color:#1e293b;">${pct}%</strong> of ${fmt$(goal.revenue_target)} revenue goal
          </p>
        </td></tr>
      </table>`
  })() : ''

  // "From Your Team" — prefer the grounded AI weekly recap, fall back to the
  // manually-written agency note. The recap is purpose-built as a 2–4 sentence
  // paragraph, so it renders in full; the manual note keeps its 180-char excerpt.
  const teamNote = recap && recap.trim()
    ? esc(recap.trim())
    : (update?.this_week
        ? esc(update.this_week.slice(0, 180)) + (update.this_week.length > 180 ? '…' : '')
        : '')

  const updateHtml = teamNote ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0 0;">
      <tr><td style="background:#f8fafc;border-left:3px solid #e53935;border-radius:0 8px 8px 0;padding:14px 16px;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#94a3b8;">From Your Team</p>
        <p style="margin:0;font-size:13px;color:#475569;line-height:1.5;">
          ${teamNote}
        </p>
      </td></tr>
    </table>` : ''

  const badgeStyle = (c) => `display:inline-block;background:${c}1a;color:${c};font-size:11px;font-weight:700;padding:2px 8px;border-radius:20px;`

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>${client.name} — Weekly Performance</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

        <!-- Header -->
        <tr><td style="padding:0 0 16px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td>
                <div style="display:inline-flex;align-items:center;gap:8px;">
                  <div style="width:28px;height:28px;background:#e53935;border-radius:8px;display:inline-block;"></div>
                  <span style="font-size:13px;font-weight:800;color:#374151;">10X Performance</span>
                </div>
              </td>
              <td align="right" style="font-size:11px;color:#94a3b8;font-weight:600;">${dateRange()}</td>
            </tr>
          </table>
        </td></tr>

        <!-- Hero card -->
        <tr><td style="background:#0a0a0a;border-radius:16px;padding:28px;margin-bottom:12px;overflow:hidden;">
          <p style="margin:0 0 4px;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.15em;color:rgba(255,255,255,.4);">
            ${client.name}
          </p>
          <h1 style="margin:0 0 20px;font-size:26px;font-weight:900;color:#fff;line-height:1.1;">Your Week in Numbers</h1>

          <!-- KPI row -->
          <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid rgba(255,255,255,.08);padding-top:20px;">
            <tr>
              <td width="33%" style="padding-right:16px;">
                <p style="margin:0 0 2px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:rgba(255,255,255,.4);">Revenue</p>
                <p style="margin:0;font-size:24px;font-weight:900;color:#fff;line-height:1;">${fmt$(rev)}</p>
                ${revLabel ? `<p style="margin:6px 0 0;${badgeStyle(rev >= (prevStats?.total_revenue||0) ? '#10b981' : '#e53935')}">${revLabel}</p>` : ''}
              </td>
              <td width="33%" style="padding:0 8px;border-left:1px solid rgba(255,255,255,.08);">
                <p style="margin:0 0 2px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:rgba(255,255,255,.4);">Jobs Won</p>
                <p style="margin:0;font-size:24px;font-weight:900;color:#fff;line-height:1;">${fmtN(jobs)}</p>
                ${jobLabel ? `<p style="margin:6px 0 0;${badgeStyle(jobs >= (prevStats?.total_closed||0) ? '#10b981' : '#e53935')}">${jobLabel}</p>` : ''}
              </td>
              <td width="33%" style="padding-left:16px;border-left:1px solid rgba(255,255,255,.08);">
                <p style="margin:0 0 2px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:rgba(255,255,255,.4);">Marketing ROAS</p>
                <p style="margin:0;font-size:24px;font-weight:900;color:#fff;line-height:1;">${fmtX(roas)}</p>
                <p style="margin:4px 0 0;font-size:10px;color:rgba(255,255,255,.35);">per $1 spent</p>
              </td>
            </tr>
          </table>

          ${goalHtml}
        </td></tr>

        <!-- Spacer -->
        <tr><td height="12"></td></tr>

        <!-- Update + CTA card -->
        <tr><td style="background:#fff;border-radius:16px;padding:24px;border:1px solid #e2e8f0;">
          ${updateHtml}

          <!-- CTA -->
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px;">
            <tr><td align="center">
              <a href="${dashUrl}"
                 style="display:inline-block;background:#e53935;color:#fff;font-size:14px;font-weight:800;
                        text-decoration:none;padding:14px 32px;border-radius:12px;letter-spacing:.02em;">
                View Full Dashboard →
              </a>
            </td></tr>
          </table>

          <p style="margin:20px 0 0;font-size:11px;color:#94a3b8;text-align:center;line-height:1.6;">
            ${leads > 0 ? `${fmtN(leads)} new leads this period · ` : ''}Powered by 10X Marketing Dashboard
          </p>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:20px 0;text-align:center;">
          <p style="margin:0;font-size:11px;color:#94a3b8;line-height:1.6;">
            You're receiving this because your agency set up this dashboard.<br>
            <a href="${unsubUrl}" style="color:#94a3b8;">Unsubscribe</a>
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`
}

// ── Public send function ──────────────────────────────────────────────────────
async function sendDigest({ client, stats, prevStats, goal, update, recap }) {
  if (!resend) {
    console.log('[email] RESEND_API_KEY not set — skipping send for', client.name)
    return { skipped: true }
  }
  if (!client.digest_email) {
    console.log('[email] no digest_email for', client.name)
    return { skipped: true }
  }

  const html = buildHtml({
    client, stats, prevStats, goal, update, recap,
    unsubToken: client.unsubscribe_token || 'none',
  })

  const subject = `${client.name} — Your Week in Numbers (${dateRange()})`

  const { data, error } = await resend.emails.send({
    from: FROM,
    to:   client.digest_email,
    subject,
    html,
  })

  if (error) throw new Error(error.message || JSON.stringify(error))
  return data
}

module.exports = { sendDigest, buildHtml }
