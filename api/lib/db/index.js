/**
 * @typedef {Object} Db
 * @property {'sqlite'|'postgres'} dialect
 * @property {(sql: string, params?: unknown[]) => Promise<{rows: Record<string, unknown>[], changes: number}>} query
 *   One statement, `?` placeholders. Returns rows for reads, `changes` for writes.
 * @property {(sql: string) => Promise<void>} exec  A multi-statement script with no parameters (migrations).
 * @property {<T>(fn: (tx: Db) => Promise<T>) => Promise<T>} transaction  Runs `fn` atomically; nested calls throw.
 * @property {(dir: string) => Promise<{applied: string[]}>} migrate
 * @property {() => Promise<void>} close
 * @property {(dest: string) => Promise<void>} [backup]  SQLite only.
 */

/**
 * Open a database from a URL. Picks the adapter from the scheme.
 * @param {string} url  `sqlite:<path|:memory:>` or `postgres://…`
 * @returns {Promise<Db>}
 */
export async function openDb(url) {
  if (typeof url !== 'string' || url.length === 0) throw new Error('TASKSCAPE_DATABASE_URL is not set');
  if (url.startsWith('sqlite:')) {
    const { openSqlite } = await import('./sqlite.js');
    return openSqlite(url);
  }
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    const { openPostgres } = await import('./postgres.js');
    return openPostgres(url);
  }
  throw new Error('Unsupported database URL scheme; use sqlite: or postgres://');
}
