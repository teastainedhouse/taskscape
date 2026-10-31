// Local dev server: static files from /public plus the API on /api/*, the
// way a static host with serverless functions would wire them up.
import http from 'node:http';
import { stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../api/lib/config.js';
import { openDb } from '../api/lib/db/index.js';
import { createApp } from '../api/index.js';
import { ensureCatchAll } from '../api/lib/repo/projects.js';
import { toWebRequest, writeResponse } from '../api/lib/node-bridge.js';

try { process.loadEnvFile('.env'); } catch { /* no .env is fine */ }

const ROOT = path.resolve('public');
const MIGRATIONS = path.resolve('migrations');
const PORT = Number(process.env.PORT || 3000);
// Loopback by default: behind a reverse proxy the identity headers are only
// trustworthy if the proxy is the one way in. HOST=0.0.0.0 opens it up.
const HOST = process.env.HOST || '127.0.0.1';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.gif': 'image/gif',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};

const config = loadConfig();
const dbUrl = process.env.TASKSCAPE_DATABASE_URL || 'sqlite:./data/dev.db';
const db = await openDb(dbUrl);
const { applied } = await db.migrate(MIGRATIONS);
if (applied.length) console.log(`migrated: ${applied.join(', ')}`);
if (await ensureCatchAll(db, config)) console.log(`created catch-all project "${config.catch_all_project.name}"`);
const app = createApp({ config, db });

async function serveStatic(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT + path.sep) && file !== ROOT) { res.writeHead(404); res.end('Not found'); return; }
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error('not a file');
    const body = await readFile(file);
    const headers = {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    };
    if (path.extname(file) === '.html') {
      headers['Content-Security-Policy'] = "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
    }
    res.writeHead(200, headers);
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if ((req.url ?? '').startsWith('/api/') || req.url === '/api') {
      await writeResponse(res, await app.fetch(toWebRequest(req)));
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      await serveStatic(req, res);
    } else {
      res.writeHead(405, { Allow: 'GET, HEAD' }); res.end();
    }
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal error');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Taskscape dev server  http://${HOST}:${PORT}`);
  console.log(`  database  ${dbUrl}`);
  console.log(`  identity  ${config.auth.provider}${config.auth.provider === 'dev' ? '  (users: ' + config.auth.dev.users.map((u) => u.id).join(', ') + ')' : ''}`);
  if (config.auth.provider === 'dev') {
    console.log('  WARNING   dev identity: anyone who can reach this port can act as any dev user. Keep it on your machine; set TASKSCAPE_ENV=production and TASKSCAPE_AUTH_PROVIDER=headers on a host.');
  }
});
