const db     = require('../config/db');
const { getIO } = require('../config/socket');
const { sendChatMessage } = require('../services/chatSend');

// ── POST send message (REST fallback when WebSocket is unavailable) ───────────
async function sendMessage(req, res, next) {
  try {
    const streamId = req.resolvedStreamId;
    const { content } = req.body;

    const { message } = await sendChatMessage({
      streamIdRaw: streamId,
      content,
      user: req.user,
    });

    getIO().to(`stream:${streamId}`).emit('chat:message', message);
    res.status(201).json({ message });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    next(err);
  }
}

// ── GET chat history for a stream ─────────────────────────────────────────────
async function getHistory(req, res, next) {
  try {
    const streamId = req.resolvedStreamId;
    const limit  = Math.min(parseInt(req.query.limit  || '50'), 200);
    const before = req.query.before; // ISO timestamp cursor for pagination

    let query = `
      SELECT
        m.id, m.content, m.is_pinned, m.created_at,
        u.id   AS user_id,
        u.username,
        u.avatar_url,
        u.role
      FROM chat_messages m
      JOIN users u ON u.id = m.user_id
      WHERE m.stream_id = $1
        AND m.is_deleted = FALSE
        ${before ? 'AND m.created_at < $3' : ''}
      ORDER BY m.created_at DESC
      LIMIT $2
    `;
    const params = before ? [streamId, limit, before] : [streamId, limit];
    const { rows } = await db.query(query, params);

    res.json({ messages: rows.reverse() });
  } catch (err) {
    next(err);
  }
}

// ── GET pinned message for a stream ───────────────────────────────────────────
async function getPinned(req, res, next) {
  try {
    const streamId = req.resolvedStreamId;
    const { rows } = await db.query(
      `SELECT m.id, m.content, m.created_at,
              u.id AS user_id, u.username, u.avatar_url
       FROM chat_messages m
       JOIN users u ON u.id = m.user_id
       WHERE m.stream_id = $1 AND m.is_pinned = TRUE AND m.is_deleted = FALSE
       ORDER BY m.created_at DESC
       LIMIT 1`,
      [streamId]
    );
    res.json({ pinned: rows[0] || null });
  } catch (err) {
    next(err);
  }
}

// ── PIN a message (host/admin only) ──────────────────────────────────────────
async function pinMessage(req, res, next) {
  try {
    const { streamId, messageId } = req.params;

    // Unpin any existing pinned message first
    await db.query(
      `UPDATE chat_messages SET is_pinned = FALSE
       WHERE stream_id = $1 AND is_pinned = TRUE`,
      [streamId]
    );

    const { rows } = await db.query(
      `UPDATE chat_messages
       SET is_pinned = TRUE
       WHERE id = $1 AND stream_id = $2 AND is_deleted = FALSE
       RETURNING id, content, created_at`,
      [messageId, streamId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Message not found' });
    }

    // Broadcast pin event to all viewers in the stream room
    getIO().to(`stream:${streamId}`).emit('chat:pinned', { message: rows[0] });
    res.json({ pinned: rows[0] });
  } catch (err) {
    next(err);
  }
}

// ── UNPIN a message (host/admin only) ─────────────────────────────────────────
async function unpinMessage(req, res, next) {
  try {
    const { streamId, messageId } = req.params;
    await db.query(
      `UPDATE chat_messages SET is_pinned = FALSE
       WHERE id = $1 AND stream_id = $2`,
      [messageId, streamId]
    );
    getIO().to(`stream:${streamId}`).emit('chat:unpinned', { messageId });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

// ── DELETE a message (host/admin only) ────────────────────────────────────────
async function deleteMessage(req, res, next) {
  try {
    const { streamId, messageId } = req.params;
    const { rows } = await db.query(
      `UPDATE chat_messages
       SET is_deleted = TRUE, deleted_by = $3
       WHERE id = $1 AND stream_id = $2
       RETURNING id`,
      [messageId, streamId, req.user.dbId]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Message not found' });
    }
    getIO().to(`stream:${streamId}`).emit('chat:deleted', { messageId });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

// ── MUTE a user in a stream (host/admin only) ─────────────────────────────────
async function muteUser(req, res, next) {
  try {
    const streamId = req.resolvedStreamId;
    const { userId }   = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    await db.query(
      `INSERT INTO muted_users (stream_id, user_id, muted_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (stream_id, user_id) DO NOTHING`,
      [streamId, userId, req.user.dbId]
    );

    getIO().to(`stream:${streamId}`).emit('chat:user_muted', { userId });
    res.json({ success: true, message: 'User muted' });
  } catch (err) {
    next(err);
  }
}

// ── UNMUTE a user ─────────────────────────────────────────────────────────────
async function unmuteUser(req, res, next) {
  try {
    const streamId = req.resolvedStreamId;
    const { userId }   = req.body;
    await db.query(
      `DELETE FROM muted_users WHERE stream_id = $1 AND user_id = $2`,
      [streamId, userId]
    );
    getIO().to(`stream:${streamId}`).emit('chat:user_unmuted', { userId });
    res.json({ success: true, message: 'User unmuted' });
  } catch (err) {
    next(err);
  }
}

// ── GET muted users for a stream ──────────────────────────────────────────────
async function getMutedUsers(req, res, next) {
  try {
    const streamId = req.resolvedStreamId;
    const { rows } = await db.query(
      `SELECT u.id, u.username, u.avatar_url, mu.muted_at
       FROM muted_users mu
       JOIN users u ON u.id = mu.user_id
       WHERE mu.stream_id = $1`,
      [streamId]
    );
    res.json({ mutedUsers: rows });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  sendMessage,
  getHistory,
  getPinned,
  pinMessage,
  unpinMessage,
  deleteMessage,
  muteUser,
  unmuteUser,
  getMutedUsers,
};
