const { Server } = require('socket.io');
const { verifyWithLaravel } = require('../middleware/auth');
const logger = require('../config/logger');

let io;

function initSocket(httpServer) {
  const origins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(',');

  io = new Server(httpServer, {
    cors: {
      origin: origins,
      methods: ['GET', 'POST'],
      credentials: true,
    },
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  // ── Auth middleware for every socket connection ────────────────────────────
  // The client must pass their Laravel Sanctum token:
  //   socket = io(URL, { auth: { token: 'your-sanctum-token' } })
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token
               || socket.handshake.headers?.authorization?.replace('Bearer ', '')
               || socket.handshake.query?.token;

    if (!token) {
      return next(new Error('Authentication required — pass your Sanctum token'));
    }

    try {
      // Verify against Laravel — uses the same in-memory cache as HTTP middleware
      socket.user = await verifyWithLaravel(token);
      logger.debug(`Socket auth OK: ${socket.user.username} (${socket.user.role})`);
      next();
    } catch (err) {
      logger.warn(`Socket auth failed: ${err.message}`);
      next(new Error(err.message));
    }
  });

  io.on('connection', (socket) => {
    logger.info(`Socket connected: ${socket.id} | user: ${socket.user?.username} | role: ${socket.user?.role}`);

    socket.on('disconnect', (reason) => {
      logger.info(`Socket disconnected: ${socket.id} | reason: ${reason}`);
    });
  });

  return io;
}

function getIO() {
  if (!io) throw new Error('Socket.io not initialised — call initSocket() first');
  return io;
}

module.exports = { initSocket, getIO };
