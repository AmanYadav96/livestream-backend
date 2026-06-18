const db = require('../config/db');
const logger = require('../config/logger');
const { resolveStreamId } = require('../services/laravelSync');

// In-memory flood tracker: { userId_streamId -> [timestamps] }
const messageTimes = new Map();
const FLOOD_WINDOW_MS  = 10000;
const FLOOD_MAX_MSGS   = 8;

function isFlooding(userId, streamId) {
  const key  = `${userId}:${streamId}`;
  const now  = Date.now();
  const times = (messageTimes.get(key) || []).filter(t => now - t < FLOOD_WINDOW_MS);
  times.push(now);
  messageTimes.set(key, times);
  return times.length > FLOOD_MAX_MSGS;
}

function registerChatHandlers(io) {
  io.on('connection', (socket) => {
    const dbUserId = () => socket.user.dbId;

    // ── Join stream room ────────────────────────────────────────────────────
    socket.on('chat:join', async ({ streamId }) => {
      if (!streamId) {
        logger.warn('chat:join rejected: missing streamId', { socketId: socket.id });
        return;
      }
      try {
        const resolved = await resolveStreamId(streamId);
        socket.join(`stream:${resolved}`);
        logger.info('chat:join', {
          socketId: socket.id,
          username: socket.user.username,
          streamId: resolved,
          room: `stream:${resolved}`,
        });
      } catch (err) {
        logger.warn('chat:join failed', { error: err.message });
      }
    });

    // ── Leave stream room ───────────────────────────────────────────────────
    socket.on('chat:leave', async ({ streamId }) => {
      if (!streamId) return;
      try {
        const resolved = await resolveStreamId(streamId);
        socket.leave(`stream:${resolved}`);
        logger.info('chat:leave', {
          socketId: socket.id,
          username: socket.user.username,
          streamId: resolved,
        });
      } catch (err) {
        logger.warn('chat:leave failed', { error: err.message });
      }
    });

    // ── Send message ────────────────────────────────────────────────────────
    socket.on('chat:send', async ({ streamId, content }, callback) => {
      const cb = typeof callback === 'function' ? callback : () => {};

      if (!streamId || !content || typeof content !== 'string') {
        logger.warn('chat:send rejected: invalid payload', { socketId: socket.id, streamId });
        return cb({ error: 'streamId and content are required' });
      }
      const trimmed = content.trim().slice(0, 500);
      if (!trimmed.length) {
        logger.warn('chat:send rejected: empty message', { socketId: socket.id, streamId });
        return cb({ error: 'Message cannot be empty' });
      }

      let resolved;
      try {
        resolved = await resolveStreamId(streamId);
      } catch (err) {
        return cb({ error: err.message || 'Invalid stream' });
      }

      const { rows: muted } = await db.query(
        `SELECT 1 FROM muted_users WHERE stream_id = $1 AND user_id = $2`,
        [resolved, dbUserId()]
      );
      if (muted.length) {
        logger.warn('chat:send rejected: user muted', {
          socketId: socket.id,
          userId: dbUserId(),
          streamId: resolved,
        });
        return cb({ error: 'You are muted in this stream' });
      }

      if (isFlooding(dbUserId(), resolved)) {
        logger.warn('chat:send rejected: flood', {
          socketId: socket.id,
          userId: dbUserId(),
          streamId: resolved,
        });
        return cb({ error: 'You are sending messages too quickly' });
      }

      try {
        const { rows } = await db.query(
          `INSERT INTO chat_messages (stream_id, user_id, content)
           VALUES ($1, $2, $3)
           RETURNING id, content, is_pinned, created_at`,
          [resolved, dbUserId(), trimmed]
        );

        const message = {
          ...rows[0],
          user_id:    dbUserId(),
          username:   socket.user.dbUsername || socket.user.username,
          avatar_url: socket.user.dbAvatarUrl || socket.user.avatar_url || null,
          role:       socket.user.dbRole || socket.user.role,
        };

        io.to(`stream:${resolved}`).emit('chat:message', message);
        logger.info('chat:send OK', {
          socketId: socket.id,
          messageId: message.id,
          streamId: resolved,
          userId: dbUserId(),
        });
        cb({ success: true, message });
      } catch (err) {
        logger.error('chat:send failed', {
          socketId: socket.id,
          streamId: resolved,
          error: err.message,
        });
        cb({ error: 'Failed to send message' });
      }
    });

    // ── Typing indicator ────────────────────────────────────────────────────
    socket.on('chat:typing', async ({ streamId }) => {
      if (!streamId) return;
      try {
        const resolved = await resolveStreamId(streamId);
        logger.debug('chat:typing', {
          socketId: socket.id,
          username: socket.user.username,
          streamId: resolved,
        });
        socket.to(`stream:${resolved}`).emit('chat:typing', {
          userId:   dbUserId(),
          username: socket.user.dbUsername || socket.user.username,
        });
      } catch (err) {
        logger.warn('chat:typing failed', { error: err.message });
      }
    });
  });
}

module.exports = { registerChatHandlers };
