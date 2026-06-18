const router = require('express').Router();
const db     = require('../config/db');
const { authenticate, requireHost } = require('../middleware/auth');
const { resolveByChannel, resolveByContent } = require('../controllers/streamsController');

// Resolve Laravel live TV channel id → backend stream UUID (no auth required)
router.get('/channel/:channelId', resolveByChannel);

// Resolve VOD content (movie, tvshow, episode, video) → backend stream UUID
router.get('/content/:contentType/:contentId', resolveByContent);

// GET all live streams
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT s.id, s.title, s.description, s.is_live, s.started_at,
              u.id AS host_id, u.username AS host_username, u.avatar_url AS host_avatar
       FROM streams s
       JOIN users u ON u.id = s.host_id
       WHERE s.is_live = TRUE
       ORDER BY s.started_at DESC`
    );
    res.json({ streams: rows });
  } catch (err) { next(err); }
});

// GET single stream
router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT s.*, u.username AS host_username, u.avatar_url AS host_avatar
       FROM streams s JOIN users u ON u.id = s.host_id
       WHERE s.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Stream not found' });
    res.json({ stream: rows[0] });
  } catch (err) { next(err); }
});

// CREATE stream (host only)
router.post('/', authenticate, requireHost, async (req, res, next) => {
  try {
    const { title, description } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });
    const { rows } = await db.query(
      `INSERT INTO streams (host_id, title, description)
       VALUES ($1, $2, $3) RETURNING *`,
      [req.user.id, title, description || null]
    );
    res.status(201).json({ stream: rows[0] });
  } catch (err) { next(err); }
});

// GO LIVE / END stream (host only)
router.patch('/:id/go-live', authenticate, requireHost, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `UPDATE streams SET is_live = TRUE, started_at = NOW()
       WHERE id = $1 AND host_id = $2 RETURNING *`,
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Stream not found' });
    res.json({ stream: rows[0] });
  } catch (err) { next(err); }
});

router.patch('/:id/end', authenticate, requireHost, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `UPDATE streams SET is_live = FALSE, ended_at = NOW()
       WHERE id = $1 AND host_id = $2 RETURNING *`,
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Stream not found' });
    res.json({ stream: rows[0] });
  } catch (err) { next(err); }
});

module.exports = router;
