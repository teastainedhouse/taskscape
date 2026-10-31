// MCP tools against a fake fetch: no network, no server. Checks the headers
// every call carries, schema validation the SDK does not do for us, the
// shape of error texts, and the multi-request flows (tags by name).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../mcp/client.js';
import { TOOLS, DATA_NOTICE, NOT_FOUND_TEXT, callTool, validateArgs } from '../mcp/tools.js';

const TOKEN = 'tsk_test_token_value';
const SESSION = '11111111-2222-4333-8444-555555555555';

const task = (over = {}) => ({
  id: 't1', project_id: 'p1', project_name: 'Website refresh', title: 'Fix broken GIFs', status: 'To do',
  owner_id: 'alice', owner_name: 'Alice Lin', private: false, due_date: null, notes: '', version: 1,
  created_at: '2026-10-31T07:00:00.000Z', updated_at: '2026-10-31T07:00:00.000Z', deleted_at: null, tags: [], ...over,
});

const json = (status, body) => ({ status, body });
const notFound = () => json(404, { error: { code: 'not_found', message: 'Not found.' } });

/**
 * A fake fetch. `route(method, path, body, query)` returns `{status, body}`.
 * Every request is recorded in `calls`.
 */
function fakeFetch(route) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    const headers = init.headers ?? {};
    const call = { method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body, headers };
    calls.push(call);
    const out = (await route(call)) ?? notFound();
    return new Response(JSON.stringify(out.body), {
      status: out.status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  };
  return { fetch, calls };
}

function makeClient(route) {
  const f = fakeFetch(route);
  const client = createClient({ baseUrl: 'http://api.test/', token: TOKEN, sessionId: SESSION, fetch: f.fetch });
  return { client, calls: f.calls };
}

const text = (result) => result.content[0].text;
const parsed = (result) => JSON.parse(text(result));

test('tool definitions: exactly the eight tools, plain JSON Schema, data-not-instructions sentence', () => {
  assert.deepEqual(TOOLS.map((t) => t.name), ['list_projects', 'list_tasks', 'get', 'create', 'update', 'delete', 'restore', 'tag']);
  for (const t of TOOLS) {
    assert.ok(t.description.endsWith(DATA_NOTICE), `${t.name} description ends with the notice`);
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(JSON.parse(JSON.stringify(t.inputSchema)).type, 'object', 'schema is plain JSON');
  }
  const del = TOOLS.find((t) => t.name === 'delete');
  assert.match(del.description, /Moves ONE item to the trash \(nothing is permanently deleted\)\. Call once per item; never loop over a list without the user confirming each item\./);
  assert.equal(del.inputSchema.properties.id.type, 'string');
  const upd = TOOLS.find((t) => t.name === 'update');
  assert.ok(upd.inputSchema.required.includes('version'));
  assert.match(upd.description, /version/);
  assert.match(upd.description, /latest get or list/);
  assert.match(upd.description, /conflict.*current record/i);
  for (const name of ['update', 'delete', 'restore', 'tag']) {
    const t = TOOLS.find((x) => x.name === name);
    assert.equal(t.inputSchema.properties.version.type, 'integer', `${name}.version is an integer`);
    assert.ok(t.inputSchema.required.includes('version'), `${name} requires version`);
  }
});

test('every tool sends Bearer, the session header, the user agent, and JSON content type', async () => {
  const { client, calls } = makeClient(({ method, path }) => {
    if (path === '/api/tags') return json(200, { items: [{ id: 'tg1', name: 'bug', color: '#ff0000' }] });
    if (path === '/api/projects' && method === 'GET') return json(200, { items: [], limit: 500, offset: 0 });
    if (path === '/api/tasks' && method === 'GET') return json(200, { items: [], limit: 500, offset: 0 });
    if (path === '/api/tasks' && method === 'POST') return json(201, task());
    return json(200, task({ version: 2 }));
  });
  const results = await Promise.all([
    callTool('list_projects', {}, client),
    callTool('list_tasks', {}, client),
    callTool('get', { type: 'task', id: 't1' }, client),
    callTool('create', { type: 'task', fields: { title: 'X' } }, client),
    callTool('update', { type: 'task', id: 't1', version: 1, fields: { status: 'Doing' } }, client),
    callTool('delete', { type: 'task', id: 't1', version: 1 }, client),
    callTool('restore', { type: 'task', id: 't1', version: 1 }, client),
    callTool('tag', { type: 'task', id: 't1', version: 1, add: ['bug'] }, client),
  ]);
  for (const r of results) assert.notEqual(r.isError, true, text(r));
  assert.ok(calls.length >= 8);
  for (const c of calls) {
    assert.equal(c.headers.Authorization, `Bearer ${TOKEN}`, `${c.method} ${c.path} carries the token`);
    assert.equal(c.headers['X-Taskscape-Session'], SESSION, `${c.method} ${c.path} carries the session id`);
    assert.equal(c.headers['User-Agent'], 'taskscape-mcp/0.1');
    assert.equal(c.headers['Content-Type'], 'application/json');
  }
  // The token never appears in any output.
  for (const r of results) assert.equal(text(r).includes(TOKEN), false);
});

test('client: never throws on HTTP errors, returns {status, body}, handles non-JSON', async () => {
  const seen = [];
  const client = createClient({
    baseUrl: 'http://api.test', token: TOKEN, sessionId: SESSION,
    fetch: async (url, init) => {
      seen.push({ url, init });
      return new Response('<html>oops</html>', { status: 502, headers: { 'content-type': 'text/html' } });
    },
  });
  const res = await client.get('/api/me');
  assert.equal(res.status, 502);
  assert.deepEqual(res.body, { raw: '<html>oops</html>' });
  assert.equal(seen[0].url, 'http://api.test/api/me');
  assert.equal(seen[0].init.body, undefined);
  const r = await callTool('get', { type: 'task', id: 'x' }, client);
  assert.equal(r.isError, true);
  assert.match(text(r), /^Server error \(HTTP 502\)/);
});

test('callTool: fetch rejection becomes an error result without the token', async () => {
  const client = createClient({
    baseUrl: 'http://api.test', token: TOKEN, sessionId: SESSION,
    fetch: async () => { throw new Error('ECONNREFUSED'); },
  });
  const r = await callTool('get', { type: 'task', id: 'x' }, client);
  assert.equal(r.isError, true);
  assert.match(text(r), /^Could not reach Taskscape at http:\/\/api\.test: ECONNREFUSED/);
  assert.equal(text(r).includes(TOKEN), false);
});

test('list_tasks / list_projects map array filters to comma-separated query params', async () => {
  const { client, calls } = makeClient(() => json(200, { items: [], limit: 500, offset: 0 }));
  await callTool('list_tasks', {
    project_id: 'p1', status: ['To do', 'Doing'], owner: 'me', tag: 'bug', q: 'gif',
    due_before: '2026-12-31', due_after: '2026-01-01', include_trashed: true,
  }, client);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].path, '/api/tasks');
  assert.deepEqual(calls[0].query, {
    project: 'p1', status: 'To do,Doing', owner: 'me', tag: 'bug', q: 'gif',
    due_before: '2026-12-31', due_after: '2026-01-01', include_trashed: 'true',
  });
  await callTool('list_projects', { status: ['Active'], include_trashed: false }, client);
  assert.equal(calls[1].path, '/api/projects');
  assert.deepEqual(calls[1].query, { status: 'Active' });
  await callTool('list_projects', {}, client);
  assert.deepEqual(calls[2].query, {});
  const r = await callTool('list_tasks', {}, client);
  assert.deepEqual(parsed(r), { items: [], limit: 500, offset: 0 });
});

test('get returns the record as pretty JSON', async () => {
  const { client, calls } = makeClient(({ path }) => (path === '/api/projects/p%201' ? json(200, { id: 'p 1', version: 3 }) : null));
  const r = await callTool('get', { type: 'project', id: 'p 1' }, client);
  assert.equal(r.isError, undefined);
  assert.equal(text(r), JSON.stringify({ id: 'p 1', version: 3 }, null, 2));
  assert.equal(calls[0].path, '/api/projects/p%201');
});

test('update requires an integer version (schema) and sends version with the fields', async () => {
  const { client, calls } = makeClient(() => json(200, task({ version: 2, status: 'Doing' })));
  let r = await callTool('update', { type: 'task', id: 't1', fields: { status: 'Doing' } }, client);
  assert.equal(r.isError, true);
  assert.match(text(r), /^Invalid arguments:/);
  assert.match(text(r), /update\.version: is required/);
  r = await callTool('update', { type: 'task', id: 't1', version: '1', fields: { status: 'Doing' } }, client);
  assert.equal(r.isError, true);
  assert.match(text(r), /update\.version: expected integer, got string/);
  r = await callTool('update', { type: 'task', id: 't1', version: 1.5, fields: { status: 'Doing' } }, client);
  assert.equal(r.isError, true);
  assert.equal(calls.length, 0, 'nothing sent on validation failure');
  assert.deepEqual(validateArgs('update', { type: 'task', id: 't1', version: 1, fields: {} }), []);

  r = await callTool('update', { type: 'task', id: 't1', version: 1, fields: { status: 'Doing' } }, client);
  assert.equal(r.isError, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'PATCH');
  assert.equal(calls[0].path, '/api/tasks/t1');
  assert.deepEqual(calls[0].body, { status: 'Doing', version: 1 });
  assert.equal(parsed(r).version, 2);
});

test('update rejects fields of the other type and tags before calling the API', async () => {
  const { client, calls } = makeClient(() => json(200, task()));
  let r = await callTool('update', { type: 'project', id: 'p1', version: 1, fields: { title: 'x' } }, client);
  assert.equal(r.isError, true);
  assert.match(text(r), /update\.fields\.title: not a project field/);
  r = await callTool('create', { type: 'project', fields: { name: 'x', due_date: '2026-01-01' } }, client);
  assert.equal(r.isError, true);
  assert.match(text(r), /create\.fields\.due_date: not a project field/);
  r = await callTool('update', { type: 'task', id: 't1', version: 1, fields: { tags: ['a'] } }, client);
  assert.equal(r.isError, true);
  assert.match(text(r), /update\.fields\.tags: unknown field/);
  assert.equal(calls.length, 0);
});

test('update on 409 returns isError with both versions and the full current record as JSON', async () => {
  const current = task({ version: 4, status: 'Blocked', notes: 'changed elsewhere' });
  const { client } = makeClient(() => json(409, {
    error: { code: 'conflict', message: 'This record changed since you loaded it. Reload and retry with the current version.' },
    current,
  }));
  const r = await callTool('update', { type: 'task', id: 't1', version: 3, fields: { status: 'Doing' } }, client);
  assert.equal(r.isError, true);
  const t = text(r);
  const [head, ...rest] = t.split('\n');
  assert.equal(head, 'Conflict: task t1 is at version 4 (you sent 3). Re-read and retry with version 4.');
  const body = rest.join('\n');
  assert.ok(body.startsWith('Current record: '));
  assert.deepEqual(JSON.parse(body.slice('Current record: '.length)), current);
});

test('delete rejects an array of ids and only ever issues one DELETE', async () => {
  const { client, calls } = makeClient(() => json(200, task({ version: 2, deleted_at: '2026-10-31T09:00:00.000Z' })));
  let r = await callTool('delete', { type: 'task', id: ['t1', 't2'], version: 1 }, client);
  assert.equal(r.isError, true);
  assert.match(text(r), /delete\.id: expected string, got array/);
  assert.equal(calls.length, 0);
  assert.ok(validateArgs('delete', { type: 'task', id: ['t1'], version: 1 }).length > 0);
  r = await callTool('delete', { type: 'task', id: 't1,t2', version: 1 }, client);
  assert.equal(r.isError, undefined);
  r = await callTool('delete', { type: 'task', id: 't1', version: 1 }, client);
  assert.equal(r.isError, undefined);
  const deletes = calls.filter((c) => c.method === 'DELETE');
  assert.equal(calls.length, 2);
  assert.equal(deletes.length, 2, 'one DELETE per call, nothing else');
  assert.equal(deletes[1].path, '/api/tasks/t1');
  assert.deepEqual(deletes[1].body, { version: 1 });
  assert.ok(parsed(r).deleted_at);
  r = await callTool('delete', { type: 'task', id: 't1' }, client);
  assert.match(text(r), /delete\.version: is required/);
  r = await callTool('delete', { type: 'task', id: '', version: 1 }, client);
  assert.match(text(r), /delete\.id: must not be empty/);
});

test('restore posts version to /restore', async () => {
  const { client, calls } = makeClient(() => json(200, task({ version: 3 })));
  const r = await callTool('restore', { type: 'project', id: 'p1', version: 2 }, client);
  assert.equal(r.isError, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].path, '/api/projects/p1/restore');
  assert.deepEqual(calls[0].body, { version: 2 });
});

test('tag resolves names, creates missing on add, and threads version through one PUT/DELETE per tag', async () => {
  const existing = [
    { id: 'tg-bug', name: 'bug', color: '#ff0000' },
    { id: 'tg-web', name: 'web', color: '#000080' },
  ];
  let version = 5;
  const tags = [];
  const { client, calls } = makeClient(({ method, path, body }) => {
    if (method === 'GET' && path === '/api/tags') return json(200, { items: existing });
    if (method === 'POST' && path === '/api/tags') return json(201, { id: `tg-${body.name}`, name: body.name, color: '#008000' });
    const m = /^\/api\/tasks\/t1\/tags\/(.+)$/.exec(path);
    if (m) {
      if (body.version !== version) return json(409, { error: { code: 'conflict', message: 'stale' }, current: task({ version }) });
      version += 1;
      return json(200, task({ version, tags: [...tags] }));
    }
    return null;
  });
  const r = await callTool('tag', { type: 'task', id: 't1', version: 5, add: ['Urgent', 'bug'], remove: ['web', 'never-existed'] }, client);
  assert.equal(r.isError, undefined, text(r));
  const writes = calls.filter((c) => c.method === 'PUT' || c.method === 'DELETE');
  assert.deepEqual(writes.map((c) => [c.method, c.path, c.body.version]), [
    ['PUT', '/api/tasks/t1/tags/tg-urgent', 5],
    ['PUT', '/api/tasks/t1/tags/tg-bug', 6],
    ['DELETE', '/api/tasks/t1/tags/tg-web', 7],
  ]);
  const creates = calls.filter((c) => c.method === 'POST' && c.path === '/api/tags');
  assert.deepEqual(creates.map((c) => c.body), [{ name: 'urgent' }], 'only the missing add name is created, normalised');
  assert.equal(calls.filter((c) => c.method === 'GET' && c.path === '/api/tags').length, 2);
  assert.equal(parsed(r).version, 8);
  for (const c of calls) assert.equal(c.headers['X-Taskscape-Session'], SESSION);
});

test('tag with neither add nor remove is rejected; a stale version mid-way reports progress', async () => {
  const { client, calls } = makeClient(({ method, path }) => {
    if (method === 'GET' && path === '/api/tags') return json(200, { items: [{ id: 'a', name: 'a', color: '#000000' }, { id: 'b', name: 'b', color: '#000000' }] });
    if (path.endsWith('/tags/a')) return json(200, task({ version: 2 }));
    if (path.endsWith('/tags/b')) return json(409, { error: { code: 'conflict', message: 'stale' }, current: task({ version: 9 }) });
    return null;
  });
  let r = await callTool('tag', { type: 'task', id: 't1', version: 1 }, client);
  assert.equal(r.isError, true);
  assert.equal(calls.length, 0);
  r = await callTool('tag', { type: 'task', id: 't1', version: 1, add: ['a', 'b'] }, client);
  assert.equal(r.isError, true);
  assert.match(text(r), /^Conflict: task t1 is at version 9 \(you sent 2\)/);
  assert.match(text(r), /Applied before the error: added "a"\./);
});

test('create with tag names resolves and creates them before POST, sending tag_ids', async () => {
  const { client, calls } = makeClient(({ method, path, body }) => {
    if (method === 'GET' && path === '/api/tags') return json(200, { items: [{ id: 'tg-bug', name: 'bug', color: '#ff0000' }] });
    if (method === 'POST' && path === '/api/tags') return json(201, { id: 'tg-new', name: body.name, color: '#008000' });
    if (method === 'POST' && path === '/api/tasks') return json(201, task({ id: 't9', title: body.title, tags: body.tag_ids.map((id) => ({ id, name: id, color: '#000000' })) }));
    return null;
  });
  const r = await callTool('create', { type: 'task', fields: { title: 'New', project_id: 'p1', tags: ['bug', 'New Thing'] } }, client);
  assert.equal(r.isError, undefined, text(r));
  assert.deepEqual(calls.map((c) => [c.method, c.path]), [
    ['GET', '/api/tags'],
    ['POST', '/api/tags'],
    ['POST', '/api/tasks'],
  ]);
  assert.deepEqual(calls[1].body, { name: 'new thing' });
  assert.deepEqual(calls[2].body, { title: 'New', project_id: 'p1', tag_ids: ['tg-bug', 'tg-new'] });
  assert.equal('tags' in calls[2].body, false);
  assert.equal(parsed(r).id, 't9');
});

test('create without tags posts straight away; project create goes to /api/projects', async () => {
  const { client, calls } = makeClient(({ method, path }) => (method === 'POST' && path === '/api/projects' ? json(201, { id: 'p9', name: 'P', version: 1 }) : null));
  const r = await callTool('create', { type: 'project', fields: { name: 'P', status: 'Active' } }, client);
  assert.equal(r.isError, undefined, text(r));
  assert.deepEqual(calls.map((c) => [c.method, c.path]), [['POST', '/api/projects']]);
  assert.deepEqual(calls[0].body, { name: 'P', status: 'Active' });
  let bad = await callTool('create', { type: 'task' }, client);
  assert.match(text(bad), /create\.fields: is required/);
  bad = await callTool('create', { type: 'thing', fields: {} }, client);
  assert.match(text(bad), /create\.type: must be one of "project", "task"/);
});

test('404 text is exact; 401 text points at TASKSCAPE_TOKEN; 400 lists field messages; 403 and invalid_state', async () => {
  const { client } = makeClient(({ path }) => {
    if (path.includes('/missing')) return notFound();
    if (path.includes('/unauth')) return json(401, { error: { code: 'unauthorized', message: 'Unauthorized.' } });
    if (path.includes('/bad')) return json(400, { error: { code: 'validation_failed', message: 'Some fields are invalid.', details: { fields: { status: 'must be one of the configured task statuses', due_date: 'must be YYYY-MM-DD' } } } });
    if (path.includes('/state')) return json(400, { error: { code: 'invalid_state', message: 'This item is in the trash.' } });
    if (path.includes('/forbid')) return json(403, { error: { code: 'forbidden', message: 'Only the owner can change privacy.' } });
    return null;
  });
  let r = await callTool('get', { type: 'task', id: 'missing' }, client);
  assert.equal(r.isError, true);
  assert.equal(text(r), NOT_FOUND_TEXT);
  assert.equal(text(r), 'Not found (it may not exist or may be private to someone else).');

  r = await callTool('get', { type: 'project', id: 'unauth' }, client);
  assert.equal(r.isError, true);
  assert.match(text(r), /^Unauthorized:/);
  assert.match(text(r), /TASKSCAPE_TOKEN/);

  r = await callTool('update', { type: 'task', id: 'bad', version: 1, fields: { status: 'Nope' } }, client);
  assert.equal(r.isError, true);
  assert.match(text(r), /^Validation failed: Some fields are invalid\./);
  assert.match(text(r), /- status: must be one of the configured task statuses/);
  assert.match(text(r), /- due_date: must be YYYY-MM-DD/);

  r = await callTool('update', { type: 'task', id: 'state', version: 1, fields: { status: 'Done' } }, client);
  assert.match(text(r), /^Invalid state: This item is in the trash\./);

  r = await callTool('update', { type: 'task', id: 'forbid', version: 1, fields: { private: true } }, client);
  assert.match(text(r), /^Forbidden: Only the owner can change privacy\./);
});

test('unknown tool and unknown argument names are rejected', async () => {
  const { client, calls } = makeClient(() => json(200, {}));
  let r = await callTool('hit', { id: 'p1' }, client);
  assert.equal(r.isError, true);
  assert.match(text(r), /unknown tool "hit"/);
  r = await callTool('get', { type: 'task', id: 't1', extra: 1 }, client);
  assert.equal(r.isError, true);
  assert.match(text(r), /get\.extra: unknown field/);
  assert.equal(calls.length, 0);
});
