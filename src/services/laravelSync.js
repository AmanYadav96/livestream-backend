const db = require('../config/db');
const logger = require('../config/logger');

const SYSTEM_USER_ID = '00000000-0000-4000-a000-000000000001';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function mapRole(role) {
  const r = (role || 'viewer').toLowerCase();
  if (r === 'administrator' || r === 'demo_admin') return 'admin';
  if (r === 'moderator') return 'admin';
  if (['host', 'admin', 'viewer'].includes(r)) return r;
  if (r === 'user' || r === 'provider') return 'viewer';
  return 'viewer';
}

/**
 * Upsert a local DB user from a verified Laravel user object.
 */
async function ensureUser(laravelUser) {
  const laravelId = String(laravelUser.id);
  const username = (laravelUser.username || `user_${laravelId}`).slice(0, 50);
  const email = laravelUser.email || `user_${laravelId}@halobox.sync`;

  const { rows } = await db.query(
    `INSERT INTO users (laravel_user_id, username, email, password, avatar_url, role)
     VALUES ($1, $2, $3, 'synced', $4, $5)
     ON CONFLICT (laravel_user_id) DO UPDATE SET
       username   = EXCLUDED.username,
       email      = CASE
                      WHEN users.email LIKE 'user_%@halobox.sync' THEN EXCLUDED.email
                      ELSE users.email
                    END,
       avatar_url = COALESCE(EXCLUDED.avatar_url, users.avatar_url),
       role       = EXCLUDED.role,
       updated_at = NOW()
     RETURNING id, username, avatar_url, role`,
    [laravelId, username, email, laravelUser.avatar_url || null, mapRole(laravelUser.role)]
  );

  return rows[0];
}

const CONTENT_KEY_RE = /^(movie|tvshow|episode|video):(\d+)$/i;

/**
 * Get or create a stream row for VOD content (movie, tvshow, episode, video).
 */
async function ensureContentStream(contentType, contentId, title = 'Video') {
  const type = String(contentType || '').toLowerCase().trim();
  const id = parseInt(contentId, 10);
  const allowed = ['movie', 'tvshow', 'episode', 'video'];
  if (!allowed.includes(type) || !Number.isFinite(id) || id <= 0) {
    throw Object.assign(new Error('Invalid content type or id'), { status: 400 });
  }

  const contentKey = `${type}:${id}`;

  const { rows } = await db.query(
    `INSERT INTO streams (content_key, title, host_id, is_live)
     VALUES ($1, $2, $3, FALSE)
     ON CONFLICT (content_key) DO UPDATE SET
       title = EXCLUDED.title
     RETURNING id`,
    [contentKey, title.slice(0, 255), SYSTEM_USER_ID]
  );

  return rows[0].id;
}

/**
 * Get or create a stream row for a Laravel live TV channel id.
 */
async function ensureStream(channelId, title = 'Live Stream') {
  const id = parseInt(channelId, 10);
  if (!Number.isFinite(id) || id <= 0) {
    throw Object.assign(new Error('Invalid channel id'), { status: 400 });
  }

  const { rows } = await db.query(
    `INSERT INTO streams (laravel_channel_id, title, host_id, is_live, started_at)
     VALUES ($1, $2, $3, TRUE, NOW())
     ON CONFLICT (laravel_channel_id) DO UPDATE SET
       title   = EXCLUDED.title,
       is_live = TRUE
     RETURNING id`,
    [id, title.slice(0, 255), SYSTEM_USER_ID]
  );

  return rows[0].id;
}

/**
 * Resolve route/socket stream id: UUID or Laravel channel integer.
 */
async function resolveStreamId(streamIdOrChannelId, title) {
  const raw = String(streamIdOrChannelId || '').trim();
  if (!raw) {
    throw Object.assign(new Error('streamId is required'), { status: 400 });
  }

  if (UUID_RE.test(raw)) {
    const { rows } = await db.query('SELECT id FROM streams WHERE id = $1', [raw]);
    if (rows.length) return rows[0].id;
  }

  const contentMatch = CONTENT_KEY_RE.exec(raw);
  if (contentMatch) {
    return ensureContentStream(contentMatch[1], contentMatch[2], title);
  }

  const channelId = parseInt(raw, 10);
  if (Number.isFinite(channelId) && channelId > 0) {
    return ensureStream(channelId, title);
  }

  throw Object.assign(new Error('Stream not found'), { status: 404 });
}

/**
 * Attach synced DB user to Laravel-normalised user object.
 */
async function attachDbUser(user) {
  try {
    const dbUser = await ensureUser(user);
    user.dbId = dbUser.id;
    user.dbUsername = dbUser.username;
    user.dbAvatarUrl = dbUser.avatar_url;
    user.dbRole = dbUser.role;
    return user;
  } catch (err) {
    logger.error('ensureUser failed', { error: err.message, laravelId: user.id });
    throw err;
  }
}

module.exports = {
  SYSTEM_USER_ID,
  ensureUser,
  ensureStream,
  ensureContentStream,
  resolveStreamId,
  attachDbUser,
};
