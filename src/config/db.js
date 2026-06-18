const { Pool } = require('pg');
const logger = require('./logger');

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'livestream_db',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
  max:      20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

let dbConnected = false;

pool.on('connect', () => {
  dbConnected = true;
  logger.info('PostgreSQL pool: client connected', {
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'livestream_db',
  });
});

pool.on('acquire', () => {
  logger.debug('PostgreSQL pool: connection acquired');
});

pool.on('remove', () => {
  logger.debug('PostgreSQL pool: client removed');
});

pool.on('error', (err) => {
  dbConnected = false;
  logger.error('PostgreSQL pool: unexpected error', { error: err.message, stack: err.stack });
});

async function checkConnection() {
  const start = Date.now();
  try {
    await pool.query('SELECT 1');
    dbConnected = true;
    const latencyMs = Date.now() - start;
    logger.debug('PostgreSQL health check OK', { latencyMs });
    return { connected: true, latencyMs };
  } catch (err) {
    dbConnected = false;
    logger.error('PostgreSQL health check FAILED', { error: err.message });
    return { connected: false, error: err.message, latencyMs: Date.now() - start };
  }
}

function isDbConnected() {
  return dbConnected;
}

module.exports = {
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),
  checkConnection,
  isDbConnected,
  pool,
};
