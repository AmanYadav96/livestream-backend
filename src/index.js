require('dotenv').config();

const http       = require('http');
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const compression = require('compression');

const { initSocket }    = require('./config/socket');
const { registerChatHandlers } = require('./sockets/chatSocket');
const { apiLimiter }    = require('./middleware/rateLimiter');
const { errorHandler, notFound } = require('./middleware/errorHandler');
const logger            = require('./config/logger');

// ── Routes ────────────────────────────────────────────────────────────────────
// Note: login/register/logout are handled by Laravel.
// Node.js only receives already-authenticated Sanctum tokens.
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

app.use(helmet());
app.use(compression());
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(apiLimiter);

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
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
server.listen(PORT, () => {
  logger.info(`🚀 Server running on port ${PORT} (${process.env.NODE_ENV || 'development'})`);
  logger.info(`🔌 Socket.io ready`);
});

module.exports = { app, server };
