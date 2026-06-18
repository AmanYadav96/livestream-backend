require('dotenv').config();

const http       = require('http');
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const compression = require('compression');

const { initSocket, isSocketReady, getSocketStats } = require('./config/socket');
const { registerChatHandlers } = require('./sockets/chatSocket');
const { checkConnection, isDbConnected } = require('./config/db');
const { runMigrations } = require('./migrations/migrate');
const { apiLimiter }    = require('./middleware/rateLimiter');
const { requestLogger } = require('./middleware/requestLogger');
const { checkLaravelConnection } = require('./middleware/auth');
const { errorHandler, notFound } = require('./middleware/errorHandler');
const logger            = require('./config/logger');

// ── Routes ────────────────────────────────────────────────────────────────────
const streamRoutes  = require('./routes/streams');
const chatRoutes    = require('./routes/chat');
const notesRoutes   = require('./routes/notes');
const bibleRoutes   = require('./routes/bible');

const app    = express();
const server = http.createServer(app);

// ── Socket.io ─────────────────────────────────────────────────────────────────
const io = initSocket(server);
registerChatHandlers(io);

// ── Global middleware ─────────────────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(',');

// Always trust one reverse proxy (nginx on VPS). Set TRUST_PROXY=false to disable.
if (process.env.TRUST_PROXY !== 'false') {
  app.set('trust proxy', 1);
}

app.use(helmet());
app.use(compression());
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    logger.warn('CORS blocked request', { origin });
    cb(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(requestLogger);
app.use(apiLimiter);

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const dbHealth = await checkConnection();
  const socketStats = getSocketStats();
  const laravelHealth = await checkLaravelConnection();

  const allOk = dbHealth.connected && socketStats.running && laravelHealth.reachable;
  const status = allOk ? 'ok' : 'degraded';

  logger.debug('Health check', { status, dbHealth, socketStats, laravelHealth });

  res.status(allOk ? 200 : 503).json({
    status,
    timestamp: new Date().toISOString(),
    services: {
      database: {
        connected: dbHealth.connected,
        latencyMs: dbHealth.latencyMs,
        ...(dbHealth.error && { error: dbHealth.error }),
      },
      socket: {
        running: socketStats.running,
        connections: socketStats.connections,
      },
      laravel: {
        url: process.env.LARAVEL_API_URL || 'not configured',
        userPath: process.env.LARAVEL_USER_PATH || '/api/v2/profile-details',
        reachable: laravelHealth.reachable,
        latencyMs: laravelHealth.latencyMs,
        ...(laravelHealth.httpStatus && { httpStatus: laravelHealth.httpStatus }),
        ...(laravelHealth.error && { error: laravelHealth.error }),
      },
    },
  });
});

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api/streams', streamRoutes);
app.use('/api/chat',    chatRoutes);
app.use('/api/notes',   notesRoutes);
app.use('/api/bible',   bibleRoutes);

// ── 404 & error handler ───────────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '4000');

async function start() {
  logger.info('Starting livestream backend...', {
    nodeEnv: process.env.NODE_ENV || 'development',
    port: PORT,
    trustProxy: process.env.TRUST_PROXY !== 'false',
    laravelTlsInsecure: process.env.LARAVEL_TLS_INSECURE !== 'false'
      && (process.env.LARAVEL_API_URL || '').startsWith('https://'),
  });

  const dbHealth = await checkConnection();
  if (dbHealth.connected) {
    logger.info('Database connected', {
      host: process.env.DB_HOST || 'localhost',
      database: process.env.DB_NAME || 'livestream_db',
      latencyMs: dbHealth.latencyMs,
    });

    if (process.env.AUTO_MIGRATE !== 'false') {
      try {
        const { applied, skipped } = await runMigrations();
        logger.info('Database migrations finished', { applied, skipped });
      } catch (err) {
        logger.error('Database migration failed — cannot start server', {
          error: err.message,
        });
        process.exit(1);
      }
    } else {
      logger.info('AUTO_MIGRATE=false — skipping migrations on startup');
    }
  } else {
    logger.error('Database NOT connected — server will start but DB operations will fail', {
      error: dbHealth.error,
    });
  }

  if (isSocketReady()) {
    logger.info('Socket.io is running and ready for connections');
  } else {
    logger.error('Socket.io failed to initialise');
  }

  server.listen(PORT, () => {
    logger.info('Server started', {
      port: PORT,
      env: process.env.NODE_ENV || 'development',
      dbConnected: isDbConnected(),
      socketRunning: isSocketReady(),
      laravelApi: process.env.LARAVEL_API_URL || 'not set',
    });
  });
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function shutdown(signal) {
  logger.info(`Received ${signal}, shutting down...`);
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', {
    reason: reason?.message || String(reason),
  });
});

start().catch((err) => {
  logger.error('Failed to start server', { error: err.message, stack: err.stack });
  process.exit(1);
});

module.exports = { app, server };
