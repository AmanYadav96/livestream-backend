const logger = require('../config/logger');
const { resolveStreamId } = require('../services/laravelSync');
const { sendChatMessage } = require('../services/chatSend');

function registerChatHandlers(io) {
  io.on('connection', (socket) => {
    const dbUserId = () => socket.user.dbId;

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

    socket.on('chat:send', async ({ streamId, content }, callback) => {
      const cb = typeof callback === 'function' ? callback : () => {};

      try {
        const { message, streamId: resolved } = await sendChatMessage({
          streamIdRaw: streamId,
          content,
          user: socket.user,
        });

        io.to(`stream:${resolved}`).emit('chat:message', message);
        logger.info('chat:send OK', {
          socketId: socket.id,
          messageId: message.id,
          streamId: resolved,
          userId: dbUserId(),
        });
        cb({ success: true, message });
      } catch (err) {
        const status = err.status || 500;
        logger.warn('chat:send rejected', {
          socketId: socket.id,
          streamId,
          status,
          error: err.message,
        });
        cb({ error: err.message || 'Failed to send message' });
      }
    });

    socket.on('chat:typing', async ({ streamId }) => {
      if (!streamId) return;
      try {
        const resolved = await resolveStreamId(streamId);
        socket.to(`stream:${resolved}`).emit('chat:typing', {
          userId: dbUserId(),
          username: socket.user.dbUsername || socket.user.username,
        });
      } catch (err) {
        logger.warn('chat:typing failed', { error: err.message });
      }
    });
  });
}

module.exports = { registerChatHandlers };
