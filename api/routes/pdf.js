'use strict'
const express = require('express')
const puppeteer = require('puppeteer')
const archiver = require('archiver')
const { query } = require('../db')

const router = express.Router()

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5174'

async function renderPDF(page, clientId, period, token) {
  // Inject auth token before navigation
  await page.evaluateOnNewDocument((t) => {
    localStorage.setItem('cv_auth_token', t)
  }, token)

  // Navigate to exec view with client/period query params
  const url = `${FRONTEND_URL}/exec?pdf=1&clientId=${clientId}&period=${period}`
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 })

  // Wait for main content to render (animated counters settle)
  await page.waitForSelector('.ev-main', { timeout: 15000 }).catch(() => {})
  await new Promise(r => setTimeout(r, 1500)) // let count-up animations finish

  return page.pdf({
    format: 'A4',
    landscape: true,
    printBackground: true,
    margin: { top: '1.2cm', right: '1.2cm', bottom: '1.2cm', left: '1.2cm' },
  })
}

// GET /api/reports/pdf/:clientId
router.get('/:clientId', async (req, res) => {
  const { clientId } = req.params
  const period = req.query.period || 'last_4w'
  const token  = req.headers.authorization?.split(' ')[1] || ''

  let browser
  try {
    // Verify client exists
    const { rows } = await query('SELECT name FROM clients WHERE id = $1', [clientId])
    if (!rows.length) return res.status(404).json({ error: 'Client not found' })
    const clientName = rows[0].name.replace(/[^a-z0-9]/gi, '-').toLowerCase()

    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    })
    const page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 800 })

    const pdf = await renderPDF(page, clientId, period, token)

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${clientName}-report.pdf"`)
    res.send(pdf)
  } catch (err) {
    console.error('[pdf]', err.message)
    res.status(500).json({ error: err.message })
  } finally {
    if (browser) await browser.close().catch(() => {})
  }
})

// GET /api/reports/pdf/all
router.get('/all', async (req, res) => {
  const period = req.query.period || 'last_4w'
  const token  = req.headers.authorization?.split(' ')[1] || ''

  let browser
  try {
    const { rows: clients } = await query(
      "SELECT id, name FROM clients WHERE status = 'active' ORDER BY name"
    )
    if (!clients.length) return res.status(404).json({ error: 'No active clients' })

    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', `attachment; filename="all-clients-reports.zip"`)

    const archive = archiver('zip', { zlib: { level: 6 } })
    archive.pipe(res)

    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    })

    for (const client of clients) {
      const page = await browser.newPage()
      await page.setViewport({ width: 1280, height: 800 })
      const pdf = await renderPDF(page, client.id, period, token)
      await page.close()
      const safeName = client.name.replace(/[^a-z0-9]/gi, '-').toLowerCase()
      archive.append(pdf, { name: `${safeName}-report.pdf` })
    }

    await archive.finalize()
  } catch (err) {
    console.error('[pdf-all]', err.message)
    if (!res.headersSent) res.status(500).json({ error: err.message })
  } finally {
    if (browser) await browser.close().catch(() => {})
  }
})

module.exports = router
