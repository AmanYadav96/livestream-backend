const axios     = require('axios');
const NodeCache = require('node-cache');
const logger    = require('../config/logger');
const { attachDbUser } = require('../services/laravelSync');

function normalizeLaravelBaseUrl(url) {
  let base = (url || 'http://localhost:8000').trim().replace(/\/+$/, '');
  if (base.endsWith('/api')) base = base.slice(0, -4);
  return base;
}

const LARAVEL_API      = normalizeLaravelBaseUrl(process.env.LARAVEL_API_URL);
const LARAVEL_USER_PATH = process.env.LARAVEL_USER_PATH || '/api/v2/profile-details';
const CACHE_TTL        = parseInt(process.env.TOKEN_CACHE_TTL || '300'); // seconds

function unwrapStreamitUser(body) {
  if (!body || typeof body !== 'object') return null;
  if (body.data && typeof body.data === 'object' && body.data.id != null) {
    return body.data;
  }
  if (body.id != null) return body;
  return null;
}

// In-memory cache: token string → user object
// Avoids calling Laravel on every single request
const tokenCache = new NodeCache({ stdTTL: CACHE_TTL, checkperiod: 60 });

/**
 * Verify Bearer token against the Halobox/Streamit Laravel API.
 * Default endpoint: GET /api/v2/profile-details (not Sanctum /api/user).
 */
async function verifyWithLaravel(token) {
  const cached = tokenCache.get(token);
  if (cached) {
    logger.debug('Auth cache hit');
    return cached;
  }

  const url = `${LARAVEL_API}${LARAVEL_USER_PATH.startsWith('/') ? '' : '/'}${LARAVEL_USER_PATH}`;

  try {
    const resp = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      timeout: 8000,
    });

    const user = unwrapStreamitUser(resp.data);
    if (!user || user.id == null) {
      logger.error('Laravel auth: unexpected response shape', {
        url,
        keys: resp.data ? Object.keys(resp.data) : [],
      });
      throw new Error('Invalid user response from Laravel');
    }

    const fullName = user.full_name
      || [user.first_name, user.last_name].filter(Boolean).join(' ').trim()
      || user.name
      || user.email
      || `user_${user.id}`;

    const normalised = {
      id:         user.id,
      name:       fullName,
      username:   fullName,
      email:      user.email || '',
      avatar_url: user.profile_image || user.file_url || user.avatar_url || null,
      role:       user.user_type || user.role || 'viewer',
      _token:     token,
    };

    tokenCache.set(token, normalised);
    logger.debug('Laravel auth OK', { userId: normalised.id, url });
    return normalised;

  } catch (err) {
    if (err.response?.status === 401 || err.response?.data?.error === 'Unauthenticated') {
      throw Object.assign(new Error('Invalid or expired token'), { status: 401 });
    }
    logger.error('Laravel auth check failed', {
      url,
      status: err.response?.status,
      message: err.message,
      laravelError: err.response?.data?.error || err.response?.data?.message,
    });
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
    logger.warn('HTTP auth rejected: no token', { path: req.path, method: req.method });
    return res.status(401).json({ error: 'No token provided' });
  }
  const token = header.split(' ')[1];
  try {
    req.user = await attachDbUser(await verifyWithLaravel(token));
    logger.debug('HTTP auth OK', {
      path: req.path,
      userId: req.user.id,
      username: req.user.username,
      role: req.user.role,
    });
    next();
  } catch (err) {
    logger.warn('HTTP auth failed', {
      path: req.path,
      status: err.status || 401,
      error: err.message,
    });
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
