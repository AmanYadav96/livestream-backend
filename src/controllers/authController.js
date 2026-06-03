const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const db     = require('../config/db');

function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role, avatar_url: user.avatar_url },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

// ── REGISTER ──────────────────────────────────────────────────────────────────
async function register(req, res, next) {
  try {
    const { username, email, password, role } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'username, email, and password are required' });
    }

    // Check duplicates
    const { rows: existing } = await db.query(
      `SELECT id FROM users WHERE email = $1 OR username = $2`,
      [email.toLowerCase(), username]
    );
    if (existing.length) {
      return res.status(409).json({ error: 'Email or username already in use' });
    }

    const hashed = await bcrypt.hash(password, 12);
    const safeRole = ['viewer', 'host'].includes(role) ? role : 'viewer';

    const { rows } = await db.query(
      `INSERT INTO users (username, email, password, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username, email, role, avatar_url, created_at`,
      [username, email.toLowerCase(), hashed, safeRole]
    );

    const token = signToken(rows[0]);
    res.status(201).json({ user: rows[0], token });
  } catch (err) {
    next(err);
  }
}

// ── LOGIN ─────────────────────────────────────────────────────────────────────
async function login(req, res, next) {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const { rows } = await db.query(
      `SELECT id, username, email, password, role, avatar_url FROM users WHERE email = $1`,
      [email.toLowerCase()]
    );
    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, rows[0].password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const { password: _, ...user } = rows[0];
    const token = signToken(user);
    res.json({ user, token });
  } catch (err) {
    next(err);
  }
}

// ── GET current user ──────────────────────────────────────────────────────────
async function me(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT id, username, email, role, avatar_url, created_at FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ user: rows[0] });
  } catch (err) {
    next(err);
  }
}

module.exports = { register, login, me };
