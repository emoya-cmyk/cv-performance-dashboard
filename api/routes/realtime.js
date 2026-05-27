'use strict'

/**
 * Server-Sent Events (SSE) middleware for real-time dashboard updates.
 * Clients connect to GET /api/realtime and receive events when data changes.
 */

const clients = new Set()

function sseMiddleware(req, res) {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.flushHeaders()

  // Send initial connection event
  res.write(`event: connected\ndata: {"ts":"${new Date().toISOString()}"}\n\n`)

  clients.add(res)

  // Keep-alive ping every 30s
  const ping = setInterval(() => {
    try {
      res.write(`: ping\n\n`)
    } catch {
      clearInterval(ping)
    }
  }, 30_000)

  req.on('close', () => {
    clearInterval(ping)
    clients.delete(res)
  })
}

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const client of clients) {
    try { client.write(msg) } catch { clients.delete(client) }
  }
}

module.exports = { sseMiddleware, broadcast }
