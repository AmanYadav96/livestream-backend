const db = require('../config/db');

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

    // ── Join stream room ────────────────────────────────────────────────────
    socket.on('chat:join', async ({ streamId }) => {
      if (!streamId) return;
      socket.join(`stream:${streamId}`);
      console.log(`${socket.user.username} joined stream:${streamId}`);
    });

    // ── Leave stream room ───────────────────────────────────────────────────
    socket.on('chat:leave', ({ streamId }) => {
      socket.leave(`stream:${streamId}`);
    });

    // ── Send message ────────────────────────────────────────────────────────
    socket.on('chat:send', async ({ streamId, content }, callback) => {
      const cb = typeof callback === 'function' ? callback : () => {};

      // Input validation
      if (!streamId || !content || typeof content !== 'string') {
        return cb({ error: 'streamId and content are required' });
      }
      const trimmed = content.trim().slice(0, 500);
      if (!trimmed.length) return cb({ error: 'Message cannot be empty' });

      // Check mute status
      const { rows: muted } = await db.query(
        `SELECT 1 FROM muted_users WHERE stream_id = $1 AND user_id = $2`,
        [streamId, socket.user.id]
      );
      if (muted.length) return cb({ error: 'You are muted in this stream' });

      // Flood check
      if (isFlooding(socket.user.id, streamId)) {
        return cb({ error: 'You are sending messages too quickly' });
      }

      try {
        const { rows } = await db.query(
          `INSERT INTO chat_messages (stream_id, user_id, content)
           VALUES ($1, $2, $3)
           RETURNING id, content, is_pinned, created_at`,
          [streamId, socket.user.id, trimmed]
        );

        const message = {
          ...rows[0],
          user_id:    socket.user.id,
          username:   socket.user.username,
          avatar_url: socket.user.avatar_url || null,
          role:       socket.user.role,
        };

        // Broadcast to everyone in the stream room (including sender)
        io.to(`stream:${streamId}`).emit('chat:message', message);
        cb({ success: true, message });
      } catch (err) {
        console.error('chat:send error:', err);
        cb({ error: 'Failed to send message' });
      }
    });

    // ── Typing indicator ────────────────────────────────────────────────────
    socket.on('chat:typing', ({ streamId }) => {
      socket.to(`stream:${streamId}`).emit('chat:typing', {
        userId:   socket.user.id,
        username: socket.user.username,
      });
    });
  });
}

module.exports = { registerChatHandlers };
