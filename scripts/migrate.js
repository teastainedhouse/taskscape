// Apply pending migrations and make sure the catch-all project exists.
// Run as a deploy step: `npm run migrate`. Never runs per request.
import path from 'node:path';
import { loadConfig } from '../api/lib/config.js';
import { openDb } from '../api/lib/db/index.js';
import { ensureCatchAll } from '../api/lib/repo/projects.js';

try { process.loadEnvFile('.env'); } catch { /* optional */ }

const url = process.env.TASKSCAPE_DATABASE_URL || 'sqlite:./data/dev.db';
const config = loadConfig();
const db = await openDb(url);
const { applied } = await db.migrate(path.resolve('migrations'));
console.log(applied.length ? `applied: ${applied.join(', ')}` : 'already up to date');
if (await ensureCatchAll(db, config)) console.log(`created catch-all project "${config.catch_all_project.name}" (${config.catch_all_project.id})`);
await db.close();
