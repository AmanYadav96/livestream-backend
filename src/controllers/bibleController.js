const db = require('../config/db');
const { getIO } = require('../config/socket');
const {
  yvFetch,
  getPassage,
  getVerseOfTheDay,
  searchPassages,
  getBibleIndex,
  getChapterWithVerses,
  purgeInvalidCache,
} = require('../services/youversionApi');

purgeInvalidCache().catch(() => {});

const DEFAULT_BIBLE_ID = parseInt(process.env.YOUVERSION_DEFAULT_BIBLE_ID || '3034', 10);

async function getVerseOfTheDayHandler(req, res, next) {
  try {
    const versionId = req.query.version_id || DEFAULT_BIBLE_ID;
    const data = await getVerseOfTheDay(versionId);
    res.json({ verseOfTheDay: { data } });
  } catch (err) {
    next(err);
  }
}

async function getVersions(req, res, next) {
  try {
    res.json({ versions: await yvFetch('/bibles?language_ranges[]=en&page_size=25') });
  } catch (err) {
    next(err);
  }
}

async function getVerse(req, res, next) {
  try {
    const { usfm } = req.params;
    const versionId = req.query.version_id || DEFAULT_BIBLE_ID;
    const passage = await getPassage(versionId, usfm);
    res.json({ verse: { data: passage } });
  } catch (err) {
    next(err);
  }
}

async function getChapter(req, res, next) {
  try {
    const { usfm } = req.params;
    const versionId = req.query.version_id || DEFAULT_BIBLE_ID;
    const parts = String(usfm || '').split('.');
    if (parts.length >= 2) {
      const chapter = await getChapterWithVerses(versionId, parts[0], parts[1]);
      return res.json({ chapter: { data: chapter } });
    }
    const passage = await getPassage(versionId, usfm);
    res.json({ chapter: { data: passage } });
  } catch (err) {
    next(err);
  }
}

async function getIndex(req, res, next) {
  try {
    const versionId = req.query.version_id || DEFAULT_BIBLE_ID;
    const index = await getBibleIndex(versionId);
    res.json({ index });
  } catch (err) {
    next(err);
  }
}

async function getStructuredChapter(req, res, next) {
  try {
    const { bookUsfm, chapterNum } = req.params;
    const versionId = req.query.version_id || DEFAULT_BIBLE_ID;
    const chapter = await getChapterWithVerses(versionId, bookUsfm, chapterNum);
    res.json({ chapter: { data: chapter } });
  } catch (err) {
    next(err);
  }
}

async function searchVerses(req, res, next) {
  try {
    const { q, version_id = DEFAULT_BIBLE_ID } = req.query;
    if (!q) return res.status(400).json({ error: 'Query parameter "q" is required' });

    const results = await searchPassages(q, version_id);
    res.json({ results });
  } catch (err) {
    next(err);
  }
}

async function pushVerse(req, res, next) {
  try {
    const streamId = req.resolvedStreamId;
    const { usfm, reference, text, version_id, version_name } = req.body;

    if (!usfm || !reference || !text) {
      return res.status(400).json({ error: 'usfm, reference, and text are required' });
    }

    const { rows } = await db.query(
      `INSERT INTO pushed_verses
         (stream_id, pushed_by, verse_id, reference, text, translation, bible_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        streamId,
        req.user.dbId,
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

    getIO().to(`stream:${streamId}`).emit('bible:verse_pushed', payload);
    res.json({ success: true, pushed: payload });
  } catch (err) {
    next(err);
  }
}

async function getPushedVerses(req, res, next) {
  try {
    const streamId = req.resolvedStreamId;
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
        req.user.dbId,
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

async function getSavedVerses(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT * FROM saved_verses WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user.dbId]
    );
    res.json({ savedVerses: rows });
  } catch (err) {
    next(err);
  }
}

async function deleteSavedVerse(req, res, next) {
  try {
    const { id } = req.params;
    const { rows } = await db.query(
      `DELETE FROM saved_verses WHERE id = $1 AND user_id = $2 RETURNING id`,
      [id, req.user.dbId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Saved verse not found' });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getVerseOfTheDay: getVerseOfTheDayHandler,
  getVersions,
  getVerse,
  getChapter,
  getIndex,
  getStructuredChapter,
  searchVerses,
  pushVerse,
  getPushedVerses,
  saveVerse,
  getSavedVerses,
  deleteSavedVerse,
};
