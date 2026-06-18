const axios     = require('axios');
const https     = require('https');
const NodeCache = require('node-cache');
const logger    = require('../config/logger');
const { attachDbUser } = require('../services/laravelSync');

function normalizeLaravelBaseUrl(url) {
  let base = (url || 'http://localhost:8000').trim().replace(/\/+$/, '');
  if (base.endsWith('/api')) base = base.slice(0, -4);
  return base;
}

const LARAVEL_API = normalizeLaravelBaseUrl(process.env.LARAVEL_API_URL);
const PRIMARY_USER_PATH = process.env.LARAVEL_USER_PATH || '/api/v2/profile-details';
const FALLBACK_USER_PATHS = (process.env.LARAVEL_USER_FALLBACK_PATHS
  || '/api/user,/api/profile-details')
  .split(',')
  .map((p) => p.trim())
  .filter(Boolean);
const CACHE_TTL = parseInt(process.env.TOKEN_CACHE_TTL || '300', 10);
// Default ON for HTTPS Laravel URLs — Node on many VPS hosts cannot verify
// trial.halobox.tv's certificate chain (UNABLE_TO_VERIFY_LEAF_SIGNATURE).
// Set LARAVEL_TLS_INSECURE=false once the SSL chain is fixed.
const LARAVEL_TLS_INSECURE = process.env.LARAVEL_TLS_INSECURE !== 'false'
  && LARAVEL_API.startsWith('https://');

const insecureHttpsAgent = LARAVEL_TLS_INSECURE
  ? new https.Agent({ rejectUnauthorized: false })
  : null;

if (LARAVEL_TLS_INSECURE) {
  logger.warn('Laravel HTTPS calls use relaxed TLS verification (LARAVEL_TLS_INSECURE). Fix the certificate chain and set LARAVEL_TLS_INSECURE=false.');
}

function resolveLaravelPath(path) {
  const raw = (path || '').trim();
  if (!raw) return '/api/v2/profile-details';
  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`;
  if (withSlash.startsWith('/api/')) return withSlash;
  return `/api${withSlash}`;
}

function buildLaravelUrl(path) {
  const resolved = resolveLaravelPath(path);
  if (resolved.startsWith('http://') || resolved.startsWith('https://')) return resolved;
  return `${LARAVEL_API}${resolved}`;
}

function unwrapStreamitUser(body) {
  if (!body || typeof body !== 'object') return null;
  if (body.status === false) return null;
  if (body.data && typeof body.data === 'object' && body.data.id != null) {
    return body.data;
  }
  if (body.id != null) return body;
  return null;
}

function mapLaravelRole(user) {
  const direct = (user.user_type || user.role || '').toLowerCase();
  if (['host', 'admin', 'moderator', 'viewer'].includes(direct)) return direct;
  if (direct === 'administrator' || direct === 'demo_admin') return 'admin';
  if (direct === 'user' || direct === 'provider') return 'viewer';

  const roles = user.roles;
  if (Array.isArray(roles) && roles.length) {
    const names = roles.map((r) => (typeof r === 'string' ? r : r.name || '').toLowerCase());
    if (names.some((n) => n === 'admin' || n === 'super-admin' || n === 'demo_admin')) return 'admin';
    if (names.some((n) => n === 'host' || n === 'moderator')) return 'host';
  }

  return 'viewer';
}

function isAuthFailure(err, data) {
  const status = err?.response?.status;
  if (status === 401 || status === 403) return true;

  const body = data || err?.response?.data;
  if (!body || typeof body !== 'object') return false;

  const message = String(body.message || body.error || '').toLowerCase();
  return body.error === 'Unauthenticated'
    || body.status === false && message.includes('unauthenticated')
    || message.includes('unauthenticated');
}

function classifyLaravelError(err, url) {
  if (isAuthFailure(err)) {
    return Object.assign(new Error('Invalid or expired token'), { status: 401 });
  }

  const status = err.response?.status;
  if (status === 404) {
    return Object.assign(
      new Error('Laravel auth endpoint not found — check LARAVEL_USER_PATH'),
      { status: 503, code: 'LARAVEL_PATH_NOT_FOUND', url }
    );
  }

  if (!err.response) {
    return Object.assign(
      new Error('Authentication service unavailable, please try again'),
      { status: 503, code: 'LARAVEL_UNREACHABLE', url, network: err.code || err.message }
    );
  }

  return Object.assign(
    new Error('Authentication service unavailable, please try again'),
    { status: 503, code: 'LARAVEL_AUTH_ERROR', url, httpStatus: status }
  );
}

function normaliseLaravelUser(user, token) {
  const fullName = user.full_name
    || [user.first_name, user.last_name].filter(Boolean).join(' ').trim()
    || user.name
    || user.email
    || `user_${user.id}`;

  return {
    id:         user.id,
    name:       fullName,
    username:   `user_${user.id}`,
    email:      user.email || '',
    avatar_url: user.profile_image || user.file_url || user.avatar_url || null,
    role:       mapLaravelRole(user),
    _token:     token,
  };
}

// In-memory cache: token string → user object
const tokenCache = new NodeCache({ stdTTL: CACHE_TTL, checkperiod: 60 });

async function fetchLaravelUser(token, path, timeoutMs) {
  const url = buildLaravelUrl(path);
  const timeout = timeoutMs || parseInt(process.env.LARAVEL_AUTH_TIMEOUT || '5000', 10);
  const resp = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
    timeout,
    ...(insecureHttpsAgent && { httpsAgent: insecureHttpsAgent }),
    validateStatus: () => true,
  });

  if (isAuthFailure({ response: resp }, resp.data)) {
    throw Object.assign(new Error('Invalid or expired token'), { status: 401, url });
  }

  if (resp.status >= 400) {
    const err = new Error(`Laravel returned HTTP ${resp.status}`);
    err.response = resp;
    throw err;
  }

  const user = unwrapStreamitUser(resp.data);
  if (!user || user.id == null) {
    const err = new Error('Invalid user response from Laravel');
    err.response = resp;
    throw err;
  }

  return { user, url };
}

/**
 * Verify Bearer token against the Halobox/Streamit Laravel API.
 * Tries profile-details first, then optional fallback paths.
 */
async function verifyWithLaravel(token) {
  const cached = tokenCache.get(token);
  if (cached) {
    logger.debug('Auth cache hit');
    return cached;
  }

  const paths = [PRIMARY_USER_PATH, ...FALLBACK_USER_PATHS.filter((p) => p !== PRIMARY_USER_PATH)];
  const timeoutMs = parseInt(process.env.LARAVEL_AUTH_TIMEOUT || '5000', 10);
  let lastError = null;
  let auth401 = null;

  // Try primary path first, then fallbacks in parallel (faster than sequential 8s × N)
  try {
    const { user } = await fetchLaravelUser(token, PRIMARY_USER_PATH, timeoutMs);
    const normalised = normaliseLaravelUser(user, token);
    tokenCache.set(token, normalised);
    logger.debug('Laravel auth OK', { userId: normalised.id, path: PRIMARY_USER_PATH, role: normalised.role });
    return normalised;
  } catch (err) {
    if (err.status === 401) throw err;
    lastError = err;
  }

  const fallbacks = paths.filter((p) => p !== PRIMARY_USER_PATH);
  if (fallbacks.length) {
    const results = await Promise.allSettled(
      fallbacks.map((path) => fetchLaravelUser(token, path, timeoutMs))
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled') {
        const normalised = normaliseLaravelUser(result.value.user, token);
        tokenCache.set(token, normalised);
        logger.debug('Laravel auth OK', { userId: normalised.id, path: fallbacks[i], role: normalised.role });
        return normalised;
      }
      const err = result.reason;
      if (err?.status === 401) auth401 = err;
      else lastError = err;
    }
  }

  if (auth401) throw auth401;

  const classified = classifyLaravelError(lastError || new Error('Laravel auth failed'), buildLaravelUrl(PRIMARY_USER_PATH));
  logger.error('Laravel auth check failed', {
    primaryUrl: buildLaravelUrl(PRIMARY_USER_PATH),
    fallbackPaths: FALLBACK_USER_PATHS,
    status: lastError?.response?.status,
    message: lastError?.message,
    code: classified.code,
    network: classified.network,
    laravelError: lastError?.response?.data?.error || lastError?.response?.data?.message,
  });
  throw classified;
}

/**
 * Probe Laravel reachability (no token). A 401 response means the API is up.
 */
async function checkLaravelConnection() {
  const url = buildLaravelUrl(PRIMARY_USER_PATH);
  const started = Date.now();
  try {
    const resp = await axios.get(url, {
      headers: { Accept: 'application/json' },
      timeout: 5000,
      ...(insecureHttpsAgent && { httpsAgent: insecureHttpsAgent }),
      validateStatus: () => true,
    });
    const latencyMs = Date.now() - started;
    const reachable = resp.status === 401 || resp.status === 200;
    return {
      reachable,
      latencyMs,
      url,
      httpStatus: resp.status,
      expected: '401 without token',
    };
  } catch (err) {
    return {
      reachable: false,
      latencyMs: Date.now() - started,
      url,
      error: err.code || err.message,
    };
  }
}

/**
 * Express middleware — verifies Sanctum Bearer token via Laravel.
 */
async function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    logger.warn('HTTP auth rejected: no token', { path: req.path, method: req.method });
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = header.split(' ')[1];
  let laravelUser;
  try {
    laravelUser = await verifyWithLaravel(token);
  } catch (err) {
    logger.warn('HTTP auth failed', {
      path: req.path,
      status: err.status || 401,
      error: err.message,
      code: err.code,
    });
    return res.status(err.status || 401).json({ error: err.message });
  }

  try {
    req.user = await attachDbUser(laravelUser);
    logger.debug('HTTP auth OK', {
      path: req.path,
      userId: req.user.id,
      username: req.user.username,
      role: req.user.role,
    });
    next();
  } catch (err) {
    logger.error('User sync failed after Laravel auth', {
      path: req.path,
      laravelId: laravelUser.id,
      error: err.message,
    });
    res.status(500).json({ error: 'Could not sync user profile, please try again' });
  }
}

function requireHost(req, res, next) {
  const allowed = ['host', 'admin', 'moderator'];
  if (!req.user || !allowed.includes(req.user.role)) {
    return res.status(403).json({ error: 'Host or admin access required' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function invalidateToken(token) {
  tokenCache.del(token);
}

module.exports = {
  authenticate,
  requireHost,
  requireAdmin,
  verifyWithLaravel,
  checkLaravelConnection,
  invalidateToken,
};
