import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { nowIso } from '../time.js';

const FILE_RE = /^(\d+)_([A-Za-z0-9-]+)(?:\.(sqlite|postgres))?\.sql$/;

/**
 * List migrations in `dir`, newest last, picking a dialect-specific override
 * (`NNN_name.<dialect>.sql`) over the neutral file when one exists.
 * @param {string} dir
 * @param {'sqlite'|'postgres'} dialect
 * @returns {Promise<Array<{id:number, name:string, file:string}>>}
 */
export async function listMigrations(dir, dialect) {
  const entries = await readdir(dir);
  /** @type {Map<number, {id:number, name:string, file:string, specific:boolean}>} */
  const byId = new Map();
  for (const entry of entries) {
    const m = FILE_RE.exec(entry);
    if (!m) continue;
    const id = Number(m[1]);
    const name = m[2];
    const forDialect = m[3];
    if (forDialect && forDialect !== dialect) continue;
    const existing = byId.get(id);
    if (existing && existing.name !== name) {
      throw new Error(`Two migrations share number ${m[1]}: ${existing.name} and ${name}`);
    }
    if (!existing || (forDialect && !existing.specific)) {
      byId.set(id, { id, name, file: path.join(dir, entry), specific: Boolean(forDialect) });
    }
  }
  return [...byId.values()].sort((a, b) => a.id - b.id).map(({ id, name, file }) => ({ id, name, file }));
}

/**
 * Apply every unapplied migration in order, each in its own transaction.
 * @param {import('./index.js').Db} db
 * @param {string} dir
 * @returns {Promise<{applied: string[]}>}
 */
export async function runMigrations(db, dir) {
  await db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
  );
  const { rows } = await db.query('SELECT id FROM schema_migrations');
  const done = new Set(rows.map((r) => Number(r.id)));
  const applied = [];
  for (const m of await listMigrations(dir, db.dialect)) {
    if (done.has(m.id)) continue;
    const sql = await readFile(m.file, 'utf8');
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)', [m.id, m.name, nowIso()]);
    });
    applied.push(`${String(m.id).padStart(3, '0')}_${m.name}`);
  }
  return { applied };
}
