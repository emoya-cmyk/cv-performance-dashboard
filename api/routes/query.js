// ============================================================
// routes/query.js — POST /api/query, the semantic query endpoint.
//
// The keystone of the Phase 1 transformation: it surfaces the atomic
// fact_metric grain (arbitrary date ranges, daily/weekly/monthly grain, channel
// and client breakdown, period-over-period compare) that the legacy weekly_
// reports columns physically cannot express. All the logic — validation,
// allow-list, SQL compilation, JS pivot — lives in semantic/compile.js; this
// router is a thin, injection-safe shell. Mounted behind requireAuth.
//
// Body (see semantic/compile.js#validateQuerySpec for the contract):
//   { clients, metrics, dateRange:{start,end}, groupBy, filters, compareTo,
//     orderBy, limit }
// → { columns, rows, meta }
// ============================================================

'use strict'

const express = require('express')
const { query } = require('../db')
const { runQuerySpec, QuerySpecError } = require('../semantic/compile')
const { catalog } = require('../semantic/registry')

const router = express.Router()

// GET /api/query/schema — the self-describing vocabulary a UI builds controls
// from: every metric, dimension, date grain and channel the POST endpoint will
// accept. Derived from the same allow-list the compiler enforces, so it can
// never advertise something the query layer would reject.
router.get('/schema', (_req, res) => {
  res.json(catalog())
})

router.post('/', async (req, res) => {
  try {
    const out = await runQuerySpec(req.body || {}, query)
    res.json(out)
  } catch (err) {
    if (err instanceof QuerySpecError || err.status === 400) {
      return res.status(400).json({ error: err.message })
    }
    console.error('[query] error', err.message)
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
