const express  = require('express')
const bcrypt   = require('bcryptjs')
const jwt      = require('jsonwebtoken')
const { query } = require('../db')
const { requireAuth } = require('../middleware/auth')

const router = express.Router()
const SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production'
const EXPIRY = '7d'

function makeToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, client_id: user.client_id || null },
    SECRET,
    { expiresIn: EXPIRY }
  )
}

// ── POST /api/auth/setup ──────────────────────────────────────────────────────
// First-run only — creates the initial agency admin account.
// Returns 403 if any users already exist.
router.post('/setup', async (req, res) => {
  try {
    const { email, password } = req.body
    if (!email || !password) return res.status(400).json({ error: 'email + password required' })

    const { rows } = await query('SELECT COUNT(*) AS n FROM users')
    if (Number(rows[0].n) > 0) return res.status(403).json({ error: 'Setup already done — use /login' })

    const hash = await bcrypt.hash(password, 10)
    const { rows: created } = await query(
      `INSERT INTO users (email, password_hash, role)
       VALUES ($1, $2, 'agency') RETURNING id, email, role`,
      [email.toLowerCase(), hash]
    )
    const user = created[0]
    res.json({ token: makeToken(user), user })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── POST /api/auth/login ──────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body
    if (!email || !password) return res.status(400).json({ error: 'email + password required' })

    const { rows } = await query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()])
    const user = rows[0]
    if (!user) return res.status(401).json({ error: 'Invalid credentials' })

    const valid = await bcrypt.compare(password, user.password_hash)
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' })

    res.json({ token: makeToken(user), user: { id: user.id, email: user.email, role: user.role, client_id: user.client_id } })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user })
})

// ── POST /api/auth/users ─────────────────────────────────────────────────────
// Agency only — create a client-scoped user account
router.post('/users', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'agency') return res.status(403).json({ error: 'Agency only' })
    const { email, password, client_id } = req.body
    if (!email || !password || !client_id) return res.status(400).json({ error: 'email, password, client_id required' })

    const hash = await bcrypt.hash(password, 10)
    const { rows: created } = await query(
      `INSERT INTO users (email, password_hash, role, client_id)
       VALUES ($1, $2, 'client', $3) RETURNING id, email, role, client_id`,
      [email.toLowerCase(), hash, client_id]
    )
    res.status(201).json({ user: created[0] })
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already exists' })
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
