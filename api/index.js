'use strict'
// Vercel serverless entry point.
// Imports the Express app (which runs migrate() on cold start) and exports it.
// Vercel's @vercel/node runtime converts Express's (req, res) interface to
// its serverless invocation — no listen() call needed here.
module.exports = require('./server.js')
