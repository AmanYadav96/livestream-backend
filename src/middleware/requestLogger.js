const logger = require('../config/logger');

function requestLogger(req, res, next) {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';

    logger[level]('HTTP request', {
      method: req.method,
      path: req.originalUrl || req.path,
      status: res.statusCode,
      durationMs: duration,
      ip: req.ip,
      userId: req.user?.id,
    });
  });

  next();
}

module.exports = { requestLogger };
