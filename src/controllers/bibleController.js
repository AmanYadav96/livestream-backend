const axios  = require('axios');
const db     = require('../config/db');
const { getIO } = require('../config/socket');
const logger = require('../config/logger');

const YV_BASE  = process.env.YOUVERSION_API_BASE_URL || 'https://developers.youversion.com/1';
const YV_TOKEN = process.env.YOUVERSION_TOKEN;

// ── Internal: YouVersion HTTP client with DB caching ─────────────────────────
const yvClient = axios.create({
  baseURL: YV_BASE,
  headers: {
    'X-YouVersion-Developer-Token': YV_TOKEN,
    'Accept': 'application/json',
  },
  timeout: 10000,
});

async function yvFetch(path) {
  const cacheKey = `yv:${path}`;

  // Check DB cache first
  const { rows: cached } = await db.query(
    `SELECT data FROM bible_cache WHERE cache_key = $1 AND expires_at > NOW()`,
    [cacheKey]
  );
  if (cached.length) {
    logger.debug(`Bible cache hit: ${cacheKey}`);
    return cached[0].data;
  }

  // Fetch from YouVersion
  const resp = await yvClient.get(path);
  const data  = resp.data;

  // Upsert into cache (24-hour TTL)
  await db.query(
    `INSERT INTO bible_cache (cache_key, data, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '24 hours')
     ON CONFLICT (cache_key) DO UPDATE
       SET data = EXCLUDED.data, expires_at = EXCLUDED.expires_at`,
    [cacheKey, JSON.stringify(data)]
  );

  return data;
}

// ── GET Verse of the Day ──────────────────────────────────────────────────────
// GET /bible/verse_of_the_day?version_id=1
async function getVerseOfTheDay(req, res, next) {
  try {
    const versionId = req.query.version_id || 1; // 1 = KJV
    const data = await yvFetch(`/verse_of_the_day?version_id=${versionId}`);
    res.json({ verseOfTheDay: data });
  } catch (err) {
    next(err);
  }
}

// ── GET list of available Bible versions ──────────────────────────────────────
// GET /bible/versions
async function getVersions(req, res, next) {
  try {
    const data = await yvFetch('/versions');
    res.json({ versions: data });
  } catch (err) {
    next(err);
  }
}

// ── GET a specific verse ───────────────────────────────────────────────────────
// GET /bible/verses/:usfm?version_id=1
// usfm example: JHN.3.16
async function getVerse(req, res, next) {
  try {
    const { usfm }      = req.params;
    const versionId     = req.query.version_id || 1;
    const data = await yvFetch(`/verses/${usfm}?version_id=${versionId}`);
    res.json({ verse: data });
  } catch (err) {
    next(err);
  }
}

// ── GET a full chapter ─────────────────────────────────────────────────────────
// GET /bible/chapters/:usfm?version_id=1
// usfm example: JHN.3
async function getChapter(req, res, next) {
  try {
    const { usfm }  = req.params;
    const versionId = req.query.version_id || 1;
    const data = await yvFetch(`/chapters/${usfm}?version_id=${versionId}`);
    res.json({ chapter: data });
  } catch (err) {
    next(err);
  }
}

// ── SEARCH verses ─────────────────────────────────────────────────────────────
// GET /bible/search?q=love&version_id=1
async function searchVerses(req, res, next) {
  try {
    const { q, version_id = 1, page = 1 } = req.query;
    if (!q) return res.status(400).json({ error: 'Query parameter "q" is required' });

    const data = await yvFetch(
      `/search?q=${encodeURIComponent(q)}&version_id=${version_id}&page=${page}`
    );
    res.json({ results: data });
  } catch (err) {
    next(err);
  }
}

// ── HOST: push verse to all viewers in a stream ───────────────────────────────
async function pushVerse(req, res, next) {
  try {
    const { streamId } = req.params;
    const { usfm, reference, text, version_id, version_name } = req.body;

    if (!usfm || !reference || !text) {
      return res.status(400).json({ error: 'usfm, reference, and text are required' });
    }

    // Persist to pushed_verses log
    const { rows } = await db.query(
      `INSERT INTO pushed_verses
         (stream_id, pushed_by, verse_id, reference, text, translation, bible_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        streamId,
        req.user.id,
        usfm,
        reference,
        text,
        version_name || 'KJV',
        String(version_id || 1),
      ]
    );

    const payload = {
      ...rows[0],
      pushed_by_username: req.user.username,
    };

    // Broadcast to every viewer in the stream room via Socket.io
    getIO().to(`stream:${streamId}`).emit('bible:verse_pushed', payload);
    res.json({ success: true, pushed: payload });
  } catch (err) {
    next(err);
  }
}

// ── GET pushed verse history for a stream ─────────────────────────────────────
async function getPushedVerses(req, res, next) {
  try {
    const { streamId } = req.params;
    const { rows } = await db.query(
      `SELECT pv.*, u.username AS pushed_by_username
       FROM pushed_verses pv
       JOIN users u ON u.id = pv.pushed_by
       WHERE pv.stream_id = $1
       ORDER BY pv.pushed_at DESC`,
      [streamId]
    );
    res.json({ pushedVerses: rows });
  } catch (err) {
    next(err);
  }
}

// ── SAVE a verse to personal library ─────────────────────────────────────────
async function saveVerse(req, res, next) {
  try {
    const { usfm, reference, text, version_id, version_name } = req.body;
    if (!usfm || !reference || !text) {
      return res.status(400).json({ error: 'usfm, reference, and text are required' });
    }

    const { rows } = await db.query(
      `INSERT INTO saved_verses
         (user_id, verse_id, reference, text, translation, bible_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, verse_id, bible_id) DO UPDATE
         SET reference = EXCLUDED.reference,
             text      = EXCLUDED.text
       RETURNING *`,
      [
        req.user.id,
        usfm,
        reference,
        text,
        version_name || 'KJV',
        String(version_id || 1),
      ]
    );
    res.status(201).json({ saved: rows[0] });
  } catch (err) {
    next(err);
  }
}

// ── GET saved verses for current user ─────────────────────────────────────────
async function getSavedVerses(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT * FROM saved_verses WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json({ savedVerses: rows });
  } catch (err) {
    next(err);
  }
}

// ── DELETE a saved verse ───────────────────────────────────────────────────────
async function deleteSavedVerse(req, res, next) {
  try {
    const { id } = req.params;
    const { rows } = await db.query(
      `DELETE FROM saved_verses WHERE id = $1 AND user_id = $2 RETURNING id`,
      [id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Saved verse not found' });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getVerseOfTheDay,
  getVersions,
  getVerse,
  getChapter,
  searchVerses,
  pushVerse,
  getPushedVerses,
  saveVerse,
  getSavedVerses,
  deleteSavedVerse,
};
