const db = require('../config/db');
const { resolveStreamId } = require('./laravelSync');

const messageTimes = new Map();
const FLOOD_WINDOW_MS = 10000;
const FLOOD_MAX_MSGS = 8;

function isFlooding(userId, streamId) {
  const key = `${userId}:${streamId}`;
  const now = Date.now();
  const times = (messageTimes.get(key) || []).filter((t) => now - t < FLOOD_WINDOW_MS);
  times.push(now);
  messageTimes.set(key, times);
  return times.length > FLOOD_MAX_MSGS;
}

/**
 * Validate, persist, and build a chat message payload (shared by socket + REST).
 */
async function sendChatMessage({ streamIdRaw, content, user, streamTitle }) {
  if (!streamIdRaw || !content || typeof content !== 'string') {
    throw Object.assign(new Error('streamId and content are required'), { status: 400 });
  }

  const trimmed = content.trim().slice(0, 500);
  if (!trimmed.length) {
    throw Object.assign(new Error('Message cannot be empty'), { status: 400 });
  }

  const resolved = await resolveStreamId(streamIdRaw, streamTitle);
  const dbUserId = user.dbId;

  const { rows: muted } = await db.query(
    `SELECT 1 FROM muted_users WHERE stream_id = $1 AND user_id = $2`,
    [resolved, dbUserId]
  );
  if (muted.length) {
    throw Object.assign(new Error('You are muted in this stream'), { status: 403 });
  }

  if (isFlooding(dbUserId, resolved)) {
    throw Object.assign(new Error('You are sending messages too quickly'), { status: 429 });
  }

  const { rows } = await db.query(
    `INSERT INTO chat_messages (stream_id, user_id, content)
     VALUES ($1, $2, $3)
     RETURNING id, content, is_pinned, created_at`,
    [resolved, dbUserId, trimmed]
  );

  return {
    message: {
      ...rows[0],
      user_id: dbUserId,
      username: user.dbUsername || user.username,
      avatar_url: user.dbAvatarUrl || user.avatar_url || null,
      role: user.dbRole || user.role,
    },
    streamId: resolved,
  };
}

module.exports = { sendChatMessage, isFlooding };
