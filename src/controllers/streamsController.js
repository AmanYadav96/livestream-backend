const { ensureStream } = require('../services/laravelSync');

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

module.exports = { resolveByChannel };
