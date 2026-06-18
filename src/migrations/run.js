require('dotenv').config();

const { runMigrations } = require('./migrate');
const logger = require('../config/logger');

runMigrations()
  .then(({ applied, skipped }) => {
    logger.info('Migrations complete', { applied, skipped });
    process.exit(0);
  })
  .catch((err) => {
    logger.error('Migration failed', { error: err.message, stack: err.stack });
    process.exit(1);
  });
