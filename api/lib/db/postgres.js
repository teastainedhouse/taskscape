import { toPositional, coerceParams } from './placeholders.js';
import { runMigrations } from './migrate.js';

const MIGRATION_LOCK = 727_427; // arbitrary advisory-lock key shared by all deployers

/**
 * PostgreSQL adapter over `pg`. Loaded only when the database URL says so,
 * so SQLite-only installs never need the package at runtime.
 * @param {string} url
 * @returns {Promise<import('./index.js').Db>}
 */
export async function openPostgres(url) {
  const { default: pg } = await import('pg');
  pg.types.setTypeParser(20, (v) => Number(v)); // int8 (COUNT(*)) as a number, like SQLite
  const pool = new pg.Pool({ connectionString: url, max: 5 });

  /** @param {{query: Function}} client @param {boolean} inTx */
  const make = (client, inTx) => ({
    dialect: 'postgres',
    inTransaction: inTx,
    async query(sql, params = []) {
      const r = await client.query(toPositional(sql), coerceParams(params));
      return { rows: r.rows, changes: r.rowCount ?? 0 };
    },
    async exec(sql) { await client.query(sql); },
    async transaction(fn) {
      if (inTx) throw new Error('Nested transactions are not supported');
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const result = await fn(make(c, true));
        await c.query('COMMIT');
        return result;
      } catch (err) {
        try { await c.query('ROLLBACK'); } catch { /* connection may be gone */ }
        throw err;
      } finally {
        c.release();
      }
    },
    async migrate(dir) {
      if (inTx) throw new Error('Run migrations outside a transaction');
      const c = await pool.connect();
      try {
        await c.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
        try { return await runMigrations(db, dir); }
        finally { await c.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]); }
      } finally {
        c.release();
      }
    },
    async close() { if (!inTx) await pool.end(); },
  });

  const db = make(pool, false);
  return db;
}
