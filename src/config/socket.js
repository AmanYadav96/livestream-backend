const { Server } = require('socket.io');
const { verifyWithLaravel } = require('../middleware/auth');
const { attachDbUser } = require('../services/laravelSync');
const logger = require('./logger');

let io = null;
let socketReady = false;

function initSocket(httpServer) {
  const origins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(',').map((o) => o.trim());
  const allowAll = origins.includes('*');

  io = new Server(httpServer, {
    path: '/socket.io',
    cors: {
      origin: allowAll ? true : origins,
      methods: ['GET', 'POST'],
      credentials: !allowAll,
    },
    transports: ['polling', 'websocket'],
    allowEIO3: true,
    pingTimeout: 60000,
    pingInterval: 25000,
    connectTimeout: 45000,
    maxHttpBufferSize: 1e6,
  });

  socketReady = true;
  logger.info('Socket.io server initialised', { allowedOrigins: origins });

  io.engine.on('connection_error', (err) => {
    logger.error('Socket.io engine connection error', {
      code: err.code,
      message: err.message,
      context: err.context,
    });
  });

  // ── Auth middleware for every socket connection ────────────────────────────
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token
               || socket.handshake.headers?.authorization?.replace('Bearer ', '')
               || socket.handshake.query?.token;

    logger.debug('Socket auth attempt', { socketId: socket.id, hasToken: !!token });

    if (!token) {
      logger.warn('Socket auth rejected: no token', { socketId: socket.id });
      return next(new Error('Authentication required — pass your Sanctum token'));
    }

    try {
      const laravelUser = await verifyWithLaravel(token);
      try {
        socket.user = await attachDbUser(laravelUser);
      } catch (syncErr) {
        logger.error('Socket user sync failed', {
          socketId: socket.id,
          laravelId: laravelUser.id,
          error: syncErr.message,
        });
        return next(new Error('Could not sync user profile, please try again'));
      }
      logger.info('Socket auth OK', {
        socketId: socket.id,
        username: socket.user.username,
        role: socket.user.role,
        userId: socket.user.id,
      });
      next();
    } catch (err) {
      logger.warn('Socket auth failed', { socketId: socket.id, error: err.message });
      next(new Error(err.message));
    }
  });

  io.on('connection', (socket) => {
    logger.info('Socket connected', {
      socketId: socket.id,
      username: socket.user?.username,
      userId: socket.user?.id,
      role: socket.user?.role,
      activeConnections: io.engine.clientsCount,
    });

    socket.onAny((event, ...args) => {
      const payload = args[0];
      logger.debug('Socket event received', {
        event,
        socketId: socket.id,
        username: socket.user?.username,
        streamId: payload?.streamId,
      });
    });

    socket.on('disconnect', (reason) => {
      logger.info('Socket disconnected', {
        socketId: socket.id,
        username: socket.user?.username,
        reason,
        activeConnections: io.engine.clientsCount,
      });
    });

    socket.on('error', (err) => {
      logger.error('Socket error', {
        socketId: socket.id,
        error: err?.message || String(err),
      });
    });
  });

  return io;
}

function getIO() {
  if (!io) throw new Error('Socket.io not initialised — call initSocket() first');
  return io;
}

function isSocketReady() {
  return socketReady && io !== null;
}

function getSocketStats() {
  if (!isSocketReady()) {
    return { running: false, connections: 0 };
  }
  return {
    running: true,
    connections: io.engine.clientsCount,
  };
}

module.exports = { initSocket, getIO, isSocketReady, getSocketStats };
