const rateLimit = require('express-rate-limit');

/** General API rate limit */
const apiLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000'),
  max:      parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100'),
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many requests, please slow down.' },
});

/** Strict limit for chat — prevent spam/flooding */
const chatLimiter = rateLimit({
  windowMs: 10000,   // 10 seconds
  max:      parseInt(process.env.CHAT_RATE_LIMIT_MAX || '20'),
  keyGenerator: (req) => req.user?.id || req.ip,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'You are sending messages too fast.' },
});

/** Auth endpoints — brute force protection */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max:      10,
  message: { error: 'Too many auth attempts, please try again later.' },
});

module.exports = { apiLimiter, chatLimiter, authLimiter };
