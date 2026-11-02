// preferences.test.js — personal preferences: site defaults, PATCH validation
// against the config, per-principal storage under any provider, human-only
// writes, and the Me shape carrying them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from './helpers.js';
import { prepareConfig } from '../api/lib/config.js';
import { readFileSync } from 'node:fs';

const NONE = { theme: false, comments_label: false, shortcuts: false, time_zone: false };
const DEFAULTS = { theme: 'toolbar', comments_label: 'Comments', shortcuts: true, time_zone: 'UTC', chosen: NONE };
const RAW = JSON.parse(readFileSync(new URL('../taskscape.config.json', import.meta.url), 'utf8'));

test('defaults come from the config; GET and the Me shape agree; a token can read', async () => {
  const t = await createTestApp({ config: { preference_defaults: { time_zone: 'Europe/Paris', comments_label: 'Guestbook' } } });
  const a = t.as('alice');
  const prefs = await a.get('/api/me/preferences');
  assert.equal(prefs.status, 200);
  assert.deepEqual(prefs.body, { ...DEFAULTS, time_zone: 'Europe/Paris', comments_label: 'Guestbook' });
  assert.deepEqual((await a.get('/api/me')).body.preferences, prefs.body);
  const tok = t.tokenAs((await a.post('/api/tokens', { label: 'x' })).body.plaintext);
  assert.deepEqual((await tok.get('/api/me/preferences')).body, prefs.body);
  assert.deepEqual((await tok.get('/api/me')).body.preferences, prefs.body);
  await t.close();
});

test('PATCH stores per principal, overlays the defaults, null goes back to the default, nothing is logged', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  const r = await a.patch('/api/me/preferences', { theme: 'netscape', time_zone: 'Asia/Tokyo' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ...DEFAULTS, theme: 'netscape', time_zone: 'Asia/Tokyo', chosen: { ...NONE, theme: true, time_zone: true } });
  assert.deepEqual((await a.get('/api/me')).body.preferences, r.body);
  // a second write keeps what the first set
  assert.deepEqual((await a.patch('/api/me/preferences', { shortcuts: false })).body, { ...DEFAULTS, theme: 'netscape', time_zone: 'Asia/Tokyo', shortcuts: false, chosen: { ...NONE, theme: true, time_zone: true, shortcuts: true } });
  // null = site default
  assert.deepEqual((await a.patch('/api/me/preferences', { theme: null, shortcuts: null })).body, { ...DEFAULTS, time_zone: 'Asia/Tokyo', chosen: { ...NONE, time_zone: true } });
  // someone else is untouched
  assert.deepEqual((await t.as('bob').get('/api/me/preferences')).body, DEFAULTS);
  // outside the versioning rule: no activity entry
  assert.equal((await a.get('/api/activity')).body.items.length, 0);
  const { rows } = await t.db.query('SELECT user_id FROM preferences');
  assert.deepEqual(rows.map((x) => x.user_id), ['alice']);
  await t.close();
});

test('validation names the field only: themes from the config, the two labels, a boolean, an IANA zone', async () => {
  const t = await createTestApp();
  const a = t.as('alice');
  for (const [body, field] of [
    [{ theme: 'solarized' }, 'theme'], [{ theme: 7 }, 'theme'],
    [{ comments_label: 'Remarks' }, 'comments_label'], [{ comments_label: 'comments' }, 'comments_label'],
    [{ shortcuts: 'yes' }, 'shortcuts'], [{ time_zone: 'Mars/Olympus' }, 'time_zone'], [{ time_zone: 'UTC; DROP' }, 'time_zone'],
    [{ time_zone: 'x'.repeat(65) }, 'time_zone'], [{ colour: 'red' }, 'body'],
  ]) {
    const r = await a.patch('/api/me/preferences', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.deepEqual(Object.keys(r.body.error.details.fields), [field]);
  }
  for (const [body, value] of [[{ theme: 'solarized' }, 'solarized'], [{ comments_label: 'Remarks' }, 'Remarks'], [{ time_zone: 'Mars/Olympus' }, 'Mars/Olympus'], [{ colour: 'red' }, 'red'], [{ 'secret key name': 1 }, 'secret key name']]) {
    assert.equal(JSON.stringify((await a.patch('/api/me/preferences', body)).body).includes(value), false, 'the value is never echoed');
  }
  assert.equal((await a.patch('/api/me/preferences', { time_zone: 'America/New_York' })).status, 200);
  // stored canonical; offsets are not zone names; a prototype key is just an unknown key
  assert.equal((await a.patch('/api/me/preferences', { time_zone: 'asia/tokyo' })).body.time_zone, 'Asia/Tokyo');
  assert.equal((await a.patch('/api/me/preferences', { time_zone: 'Asia/Kolkata' })).body.time_zone, 'Asia/Kolkata', 'the name as picked, not the runtime\'s alias');
  assert.equal((await a.patch('/api/me/preferences', { time_zone: '+05' })).status, 400);
  assert.equal((await a.patch('/api/me/preferences', JSON.parse('{"__proto__": {"x": 1}, "theme": "netscape"}'))).status, 400);
  await t.close();
});

test('writes are human-only and self-scoped; a read-only account still sets its own; cross-site is refused', async () => {
  const t = await createTestApp({ config: { permissions: { edit: 'group', groups: ['editors'] },
    auth: { dev: { users: [{ id: 'alice', name: 'Alice Lin', groups: ['editors'] }, { id: 'ro', name: 'Read Only', groups: [] }] } } } });
  const tok = t.tokenAs((await t.as('alice').post('/api/tokens', { label: 'x' })).body.plaintext);
  assert.equal((await tok.patch('/api/me/preferences', { theme: 'netscape' })).status, 403);
  assert.equal((await t.as('ro').patch('/api/me/preferences', { theme: 'netscape' })).status, 200);
  assert.equal((await t.as('alice').patch('/api/me/preferences', { theme: 'netscape' }, { 'sec-fetch-site': 'cross-site' })).status, 403);
  await t.close();
});

test('a stored theme the site no longer lists falls back to the default in the Me shape', async () => {
  const t = await createTestApp();
  await t.db.query("INSERT INTO preferences (user_id, theme, updated_at) VALUES ('alice', 'gone', '2026-01-01T00:00:00.000Z')");
  const prefs = (await t.as('alice').get('/api/me')).body.preferences;
  assert.equal(prefs.theme, 'toolbar');
  assert.equal(prefs.chosen.theme, false, 'a removed theme no longer counts as chosen');
  await t.close();
});

test('config: themes must exist as files, the default must be listed, and the defaults are validated', () => {
  assert.throws(() => prepareConfig({ ...RAW, themes: ['toolbar', 'missing'] }, {}), /theme-missing\.css/);
  assert.throws(() => prepareConfig({ ...RAW, theme: 'netscape', themes: ['toolbar'] }, {}), /theme must be one of themes/);
  assert.throws(() => prepareConfig({ ...RAW, themes: ['Tool Bar'] }, {}), /lowercase/);
  assert.throws(() => prepareConfig({ ...RAW, themes: 'netscape' }, {}), /non-empty array/);
  assert.equal(prepareConfig({ ...RAW, theme: undefined, themes: ['netscape', 'toolbar'] }, {}).theme, 'netscape', 'theme defaults to the first listed');
  assert.throws(() => prepareConfig({ ...RAW, preference_defaults: { time_zone: 'Nowhere/Here' } }, {}), /time_zone/);
  assert.throws(() => prepareConfig({ ...RAW, preference_defaults: { comments_label: 'Notes' } }, {}), /comments_label/);
  const c = prepareConfig({ ...RAW, theme: undefined, themes: undefined, preference_defaults: undefined }, {});
  assert.equal(c.theme, 'toolbar');
  assert.deepEqual(c.themes, ['toolbar']);
  assert.deepEqual(c.preference_defaults, { comments_label: 'Comments', shortcuts: true, time_zone: 'UTC' });
});
