import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { coerceParams, isReadStatement } from './placeholders.js';
import { runMigrations } from './migrate.js';

/**
 * A tiny async mutex so that one process's overlapping requests never
 * interleave statements inside another request's transaction.
 */
class Mutex {
  #tail = Promise.resolve();
  /** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  run(fn) {
    const prev = this.#tail;
    let release;
    this.#tail = new Promise((r) => { release = r; });
    return prev.then(fn).finally(release);
  }
}

/**
 * @param {string} url  `sqlite:./data/dev.db` or `sqlite::memory:`
 * @returns {import('./index.js').Db}
 */
export function openSqlite(url) {
  const file = url.replace(/^sqlite:/, '');
  if (file !== ':memory:') mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const raw = new DatabaseSync(file);
  if (file !== ':memory:') raw.exec('PRAGMA journal_mode = WAL');
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec('PRAGMA busy_timeout = 5000');
  const mutex = new Mutex();

  const queryNow = (sql, params = []) => {
    const stmt = raw.prepare(sql);
    const bound = coerceParams(params);
    if (isReadStatement(sql)) {
      const rows = stmt.all(...bound).map((r) => ({ ...r }));
      return { rows, changes: 0 };
    }
    const result = stmt.run(...bound);
    return { rows: [], changes: Number(result.changes) };
  };

  /** @type {import('./index.js').Db} */
  const inTx = {
    dialect: 'sqlite',
    async query(sql, params) { return queryNow(sql, params); },
    async exec(sql) { raw.exec(sql); },
    async transaction() { throw new Error('Nested transactions are not supported'); },
    async migrate() { throw new Error('Run migrations outside a transaction'); },
    async close() { throw new Error('Cannot close inside a transaction'); },
  };

  /** @type {import('./index.js').Db} */
  const db = {
    dialect: 'sqlite',
    query(sql, params) { return mutex.run(async () => queryNow(sql, params)); },
    exec(sql) { return mutex.run(async () => { raw.exec(sql); }); },
    transaction(fn) {
      return mutex.run(async () => {
        raw.exec('BEGIN IMMEDIATE');
        try {
          const result = await fn(inTx);
          raw.exec('COMMIT');
          return result;
        } catch (err) {
          try { raw.exec('ROLLBACK'); } catch { /* already rolled back */ }
          throw err;
        }
      });
    },
    migrate(dir) { return runMigrations(db, dir); },
    async close() { raw.close(); },
    /** SQLite only: copy the live database to `dest` with the online backup API. */
    async backup(dest) {
      const { backup } = await import('node:sqlite');
      mkdirSync(path.dirname(path.resolve(dest)), { recursive: true });
      await backup(raw, dest);
    },
  };
  return db;
}
