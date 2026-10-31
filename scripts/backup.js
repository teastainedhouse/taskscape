// Back up the database. SQLite: an online copy via node:sqlite's backup API
// (safe while the server runs). PostgreSQL: prints the pg_dump command to run.
// Usage: npm run backup [-- path/to/file.db]
import path from 'node:path';
import { openDb } from '../api/lib/db/index.js';

try { process.loadEnvFile('.env'); } catch { /* optional */ }

const url = process.env.TASKSCAPE_DATABASE_URL || 'sqlite:./data/dev.db';
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

if (!url.startsWith('sqlite:')) {
  console.log('PostgreSQL: run this with the database URL in your environment:');
  console.log(`  pg_dump --format=custom --no-owner "$TASKSCAPE_DATABASE_URL" > backups/taskscape-${stamp}.dump`);
  console.log('Restore with:');
  console.log('  pg_restore --clean --if-exists --no-owner --dbname "$TASKSCAPE_DATABASE_URL" backups/<file>.dump');
  process.exit(0);
}

const dest = process.argv[2] ?? path.join('backups', `taskscape-${stamp}.db`);
const db = await openDb(url);
await db.backup(dest);
await db.close();
console.log(`backed up ${url} -> ${dest}`);
console.log('Restore: stop the server, copy this file over the database file (and delete any -wal/-shm files beside it), start the server.');
