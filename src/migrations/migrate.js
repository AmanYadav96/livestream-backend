const fs   = require('fs');
const path = require('path');
const db     = require('../config/db');
const logger = require('../config/logger');

const MIGRATIONS_DIR = __dirname;

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         SERIAL PRIMARY KEY,
      name       VARCHAR(255) NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);
}

async function getAppliedMigrations(client) {
  const { rows } = await client.query('SELECT name FROM schema_migrations');
  return new Set(rows.map((r) => r.name));
}

/**
 * Run pending .sql files in src/migrations/ (sorted by filename).
 * Already-applied files are tracked in schema_migrations and skipped.
 */
async function runMigrations() {
  const client = await db.getClient();

  try {
    await ensureMigrationsTable(client);
    const applied = await getAppliedMigrations(client);

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    if (!files.length) {
      logger.info('No migration files found');
      return { applied: [], skipped: [] };
    }

    const appliedNew = [];
    const skipped = [];

    for (const file of files) {
      if (applied.has(file)) {
        skipped.push(file);
        logger.debug('Migration already applied, skipping', { file });
        continue;
      }

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      logger.info('Running migration', { file });

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (name) VALUES ($1)',
          [file]
        );
        await client.query('COMMIT');
        appliedNew.push(file);
        logger.info('Migration applied successfully', { file });
      } catch (err) {
        await client.query('ROLLBACK');
        logger.error('Migration failed, rolled back', { file, error: err.message });
        throw err;
      }
    }

    if (appliedNew.length === 0 && skipped.length > 0) {
      logger.info('Database schema is up to date', { skipped });
    }

    return { applied: appliedNew, skipped };
  } finally {
    client.release();
  }
}

module.exports = { runMigrations };
