const { ensureStream, ensureContentStream } = require('../services/laravelSync');

const ALLOWED_CONTENT_TYPES = ['movie', 'tvshow', 'episode', 'video'];

async function resolveByContent(req, res, next) {
  try {
    const contentType = String(req.params.contentType || '').toLowerCase();
    const contentId = parseInt(req.params.contentId, 10);

    if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
      return res.status(400).json({ error: 'Invalid content type' });
    }
    if (!Number.isFinite(contentId) || contentId <= 0) {
      return res.status(400).json({ error: 'Invalid content id' });
    }

    const title = req.query.title || req.body?.title || `${contentType} ${contentId}`;
    const streamId = await ensureContentStream(contentType, contentId, title);

    res.json({
      streamId,
      contentType,
      contentId,
      contentKey: `${contentType}:${contentId}`,
      title,
    });
  } catch (err) {
    next(err);
  }
}

async function resolveByChannel(req, res, next) {
  try {
    const channelId = parseInt(req.params.channelId, 10);
    if (!Number.isFinite(channelId) || channelId <= 0) {
      return res.status(400).json({ error: 'Invalid channel id' });
    }

    const title = req.query.title || req.body?.title || `Channel ${channelId}`;
    const streamId = await ensureStream(channelId, title);

    res.json({
      streamId,
      channelId,
      title,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { resolveByChannel, resolveByContent };
