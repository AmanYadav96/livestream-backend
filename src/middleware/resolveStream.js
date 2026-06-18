const { resolveStreamId } = require('../services/laravelSync');

/**
 * Resolves :streamId param (UUID or Laravel channel id) to req.resolvedStreamId.
 */
async function resolveStreamParam(req, res, next) {
  try {
    const title = req.query.title || req.body?.title;
    req.resolvedStreamId = await resolveStreamId(req.params.streamId, title);
    next();
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}

module.exports = { resolveStreamParam };
