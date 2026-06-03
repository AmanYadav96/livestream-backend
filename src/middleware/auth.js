const axios     = require('axios');
const NodeCache = require('node-cache');
const logger    = require('../config/logger');

const LARAVEL_API = process.env.LARAVEL_API_URL || 'http://localhost:8000';
const CACHE_TTL   = parseInt(process.env.TOKEN_CACHE_TTL || '300'); // seconds

// In-memory cache: token string → user object
// Avoids calling Laravel on every single request
const tokenCache = new NodeCache({ stdTTL: CACHE_TTL, checkperiod: 60 });

/**
 * Call Laravel's /api/user endpoint with the Sanctum token.
 * Returns the user object on success, or throws on failure.
 */
async function verifyWithLaravel(token) {
  // Check cache first
  const cached = tokenCache.get(token);
  if (cached) {
    logger.debug('Auth cache hit');
    return cached;
  }

  try {
    const resp = await axios.get(`${LARAVEL_API}/api/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      timeout: 8000,
    });

    const user = resp.data;
    if (!user || !user.id) throw new Error('Invalid user response from Laravel');

    // Normalise the user shape so the rest of the Node.js app
    // can use req.user.id, req.user.role, req.user.name consistently
    const normalised = {
      id:         user.id,
      name:       user.name        || user.display_name || '',
      username:   user.username    || user.name         || '',
      email:      user.email       || '',
      avatar_url: user.file_url    || user.avatar_url   || null,
      role:       user.user_type   || user.role         || 'viewer',
      // Keep the raw token so socket handlers can forward it if needed
      _token:     token,
    };

    // Cache the result so we don't hit Laravel on every request
    tokenCache.set(token, normalised);
    return normalised;

  } catch (err) {
    // 401 from Laravel = invalid/expired token
    if (err.response?.status === 401) {
      throw Object.assign(new Error('Invalid or expired token'), { status: 401 });
    }
    // Any other error (network, timeout) — don't let the chat go down
    logger.error('Laravel auth check failed:', err.message);
    throw Object.assign(
      new Error('Authentication service unavailable, please try again'),
      { status: 503 }
    );
  }
}

/**
 * Express middleware — verifies Sanctum Bearer token via Laravel.
 * Attaches decoded user to req.user.
 */
async function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  const token = header.split(' ')[1];
  try {
    req.user = await verifyWithLaravel(token);
    next();
  } catch (err) {
    res.status(err.status || 401).json({ error: err.message });
  }
}

/**
 * Middleware — allows only host or admin roles.
 * Must be used after authenticate().
 */
function requireHost(req, res, next) {
  // Map Laravel user_type values to allowed roles
  const allowed = ['host', 'admin', 'moderator'];
  if (!req.user || !allowed.includes(req.user.role)) {
    return res.status(403).json({ error: 'Host or admin access required' });
  }
  next();
}

/**
 * Middleware — allows only admin role.
 */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

/**
 * Manually invalidate a token from the cache (call on logout).
 */
function invalidateToken(token) {
  tokenCache.del(token);
}

module.exports = { authenticate, requireHost, requireAdmin, verifyWithLaravel, invalidateToken };
