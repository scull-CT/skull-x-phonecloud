import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHmac } from 'node:crypto';
import { start } from '../apps/server/index.mjs';
import { createBackup, restoreBackup } from '../packages/core/backups.mjs';
import { ensureSpace } from '../packages/core/store.mjs';
import { seal } from '../packages/security/security.mjs';

const password = 'long fixture administrator password';
const setup = { username: 'admin', password };
const sample = readFileSync(new URL('../examples/node/server.mjs', import.meta.url), 'utf8');
const headers = (origin, extra) => ({ 'Content-Type': 'application/json', Origin: origin, ...extra });
async function api(origin, path, method, body, extra) {
  const response = await fetch(origin + path, { method, headers: headers(origin, extra), body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  return { status: response.status, headers: response.headers, data: await response.json() };
}

async function fixture(t, overrides = {}) {
  const parent = mkdtempSync(join(tmpdir(), 'phonecloud-test-'));
  const home = join(parent, 'data');
  const options = { home, port: 0, publicPort: 0, lanPort: 0, interval: 50, lanAdmin: false, ...overrides };
  let app = await start(options);
  t.after(async () => { if (app) await app.close(); rmSync(parent, { recursive: true, force: true, maxRetries: 5 }); });
  const code = readFileSync(join(home, 'setup-code'), 'utf8').trim();
  return {
    parent, home, code, get app() { return app; },
    async restart() { await app.close(); app = null; app = await start(options); },
    async authenticate() {
      const result = await api(app.origin, '/api/setup', 'POST', { ...setup, code });
      assert.equal(result.status, 201);
      const cookie = result.headers.get('set-cookie').split(';')[0];
      const auth = { Cookie: cookie, 'X-CSRF-Token': result.data.csrf };
      const call = (path, method = 'GET', body) => api(app.origin, '/api/' + path, method, body, auth);
      return Object.assign(call, { auth });
    }
  };
}

test('same-network dashboard keeps setup local and requires a session and CSRF', async t => {
  const f = await fixture(t, { lanAdmin: true });
  const lan = f.app.lanAdminUrl();
  if (!lan) return t.skip('No private IPv4 interface');
  assert.equal((await api(f.app.origin, '/healthz', 'GET')).data.lanUrl, lan);
  assert.equal((await fetch(lan)).status, 200);
  assert.equal((await api(lan, '/api/overview', 'GET')).status, 401);
  assert.equal((await api(lan, '/api/setup', 'POST', { ...setup, code: f.code })).status, 403);
  await f.authenticate();
  assert.equal((await api(lan, '/api/login', 'POST', setup, { Origin: f.app.origin })).status, 403);
  const login = await api(lan, '/api/login', 'POST', setup);
  assert.equal(login.status, 200);
  const Cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await api(lan, '/api/overview', 'GET', undefined, { Cookie })).status, 200);
  assert.equal((await api(lan, '/api/logout', 'POST', {}, { Cookie })).status, 403);
  assert.equal((await api(lan, '/api/logout', 'POST', {}, { Cookie, 'X-CSRF-Token': login.data.csrf })).status, 200);
});

async function until(fn) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await fn();
    if (result) return result;
    await delay(100);
  }
  assert.fail('Condition did not become true');
}

test('setup, origin validation, session persistence, password rotation and monitoring', async t => {
  const f = await fixture(t);
  const { origin } = f.app;
  assert.equal((await api(origin, '/api/overview', 'GET')).status, 401);
  assert.equal((await api(origin, '/api/setup', 'POST', { ...setup, code: f.code }, { Origin: 'https://other.invalid' })).status, 403);
  assert.equal((await api(origin, '/api/setup', 'POST', { ...setup, code: 'wrong' })).status, 403);
  const call = await f.authenticate();
  assert.throws(() => readFileSync(join(f.home, 'setup-code')), { code: 'ENOENT' });
  assert.equal((await call('overview')).data.pid, process.pid);
  assert.ok((await call('metrics?hours=1')).data.history.length);
  assert.equal((await api(origin, '/api/setup', 'POST', { ...setup, code: f.code })).status, 409);
  const login = await api(origin, '/api/login', 'POST', setup);
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly; SameSite=Strict/);
  assert.equal((await api(origin, '/api/logout', 'POST', {}, { Cookie: cookie.split(';')[0] })).status, 403);
  await f.restart();
  assert.equal((await call('overview')).status, 200);
  assert.equal((await call('password', 'POST', { current: password, password: password + ' new' })).status, 200);
  assert.equal((await call('overview')).status, 401);
  assert.throws(() => ensureSpace(f.home, Number.MAX_SAFE_INTEGER), { status: 507 });
});

test('nested JSON edits are atomic, streamed, and protected against stale saves', async t => {
  const f = await fixture(t);
  const call = await f.authenticate();
  const { data: db } = await call('databases', 'POST', { name: 'Tree' });
  const base = 'databases/' + db.id;
  const collection = base + '/collections/tasks';
  await call(base + '/collections', 'POST', { name: 'tasks', fields: { title: { type: 'string', required: true } } });
  const records = base + '/records/tasks';
  const external = '/db/' + db.id + '/records/tasks';
  const { data: doc } = await call(records, 'POST', { title: 'Demo', nested: { 'a/b~': 'old', array: [1, 2] } });
  const route = records + '/' + doc.id;
  const events = await fetch(f.app.origin + '/api/' + base + '/events/tasks', { headers: call.auth, signal: AbortSignal.timeout(10000) });
  assert.equal(events.status, 200);
  const reader = events.body.getReader();
  try {
    await reader.read();
    const change = { path: ['nested', 'a/b~'], action: 'set', value: 'new', expected: 'old', updated: doc.updated };
    assert.equal((await api(f.app.origin, '/api/' + route, 'PATCH', change)).status, 401);
    const updated = await call(route, 'PATCH', change);
    assert.equal(updated.status, 200);
    assert.equal(updated.data.data.nested['a/b~'], 'new');
    assert.match(Buffer.from((await reader.read()).value).toString(), /event: change[\s\S]*"type":"update"[\s\S]*"new"/);
    assert.equal((await call(route, 'PATCH', change)).status, 409);
    assert.equal((await call(route + '?updated=' + doc.updated, 'DELETE', {})).status, 409);
    assert.equal((await call(route, 'PATCH', { path: ['title'], action: 'remove', expected: 'Demo', updated: updated.data.updated })).status, 400);
    const appended = await call(route, 'PATCH', { path: ['nested', 'array', '-'], action: 'add', value: false, updated: updated.data.updated });
    assert.deepEqual(appended.data.data.nested.array, [1, 2, false]);
    const removed = await call(route, 'PATCH', { path: ['nested', 'array', '1'], action: 'remove', expected: 2, updated: appended.data.updated });
    assert.deepEqual(removed.data.data.nested.array, [1, false]);
    const safe = await call(route, 'PATCH', { path: ['nested', '__proto__'], action: 'add', value: { safe: true }, updated: removed.data.updated });
    assert.deepEqual(safe.data.data.nested['__proto__'], { safe: true });
    assert.equal({}.safe, undefined);
    assert.equal((await api(f.app.publicOrigin, external, 'GET')).status, 403);
    assert.equal((await call(collection, 'PUT', { read: 'public', write: 'private' })).status, 200);
    assert.equal((await api(f.app.publicOrigin, external, 'GET')).status, 403);
    assert.equal((await call(base + '/rules', 'PUT', { rules: { '.read': true, '.write': true } })).status, 400);
    assert.equal((await call(base + '/rules', 'PUT', { rules: { '.read': true, '.write': false } })).status, 200);
    assert.equal((await api(f.app.publicOrigin, external, 'GET')).status, 200);
    assert.equal((await api(f.app.publicOrigin, external, 'POST', { title: 'Denied' })).status, 403);
    assert.equal((await call(route, 'PATCH', { path: [], action: 'set', expected: safe.data.data, value: {}, updated: safe.data.updated })).status, 400);
  } finally { await reader.cancel(); }
});

test('database rules default to API key only and usage tracks client access', async t => {
  const f = await fixture(t);
  const call = await f.authenticate();
  const { data: db } = await call('databases', 'POST', { name: 'Private' });
  assert.deepEqual(db.rules, { '.read': false, '.write': false });
  const base = 'databases/' + db.id;
  const collection = '/db/' + db.id + '/records/items';
  await call(base + '/collections', 'POST', { name: 'items', read: 'public', write: 'user' });
  const key = async (label, permission) => ({ Authorization: 'Bearer ' + (await call(base + '/keys', 'POST', { label, permission })).data.key });
  const read = await key('Read access', 'read');
  const write = await key('Write access', 'write');
  assert.equal((await api(f.app.publicOrigin, collection, 'GET')).status, 403);
  assert.equal((await api(f.app.publicOrigin, collection, 'POST', {})).status, 403);
  assert.equal((await api(f.app.publicOrigin, collection, 'GET', undefined, read)).status, 200);
  assert.equal((await api(f.app.publicOrigin, collection, 'POST', {}, read)).status, 403);
  assert.equal((await api(f.app.publicOrigin, collection, 'POST', { active: true }, write)).status, 200);
  const usage = (await call(base + '/usage')).data;
  assert.equal(usage.documents, 1);
  assert.equal(usage.daily[0].requests, 5);
  assert.equal(usage.daily[0].rejected, 3);
  assert.equal(usage.daily[0].writes, 1);
  f.app.store.set('domains', { 'other.example.org': { target: 'project:other' } });
  assert.equal((await call(base + '/domain', 'POST', { hostname: 'other.example.org', remove: true })).status, 409);
  assert.equal(f.app.store.get('domains')['other.example.org'].target, 'project:other');
});

test('first database hostname can be added to an unconfigured Cloudflare tunnel', async t => {
  const f = await fixture(t);
  const call = await f.authenticate();
  const { data: database } = await call('databases', 'POST', { name: 'Custom domain' });
  const id = '11111111-1111-1111-1111-111111111111';
  const hostname = 'db.example.org';
  f.app.store.set('cloudflare', seal(f.app.store.key, { id, account: 'a'.repeat(32), zone: 'b'.repeat(32), apiToken: 'fixture' }));
  const fetchReal = globalThis.fetch;
  const calls = [];
  t.mock.method(globalThis, 'fetch', (url, options) => {
    if (!url.startsWith('https://api.cloudflare.com/')) return fetchReal(url, options);
    const path = new URL(url).pathname;
    const method = options.method;
    calls.push({ path, method, body: options.body && JSON.parse(options.body) });
    if (path.endsWith('/configurations') && method === 'GET') return Promise.resolve(Response.json({ success: true, result: { config: null } }));
    if (path.endsWith('/dns_records') && method === 'GET') return Promise.resolve(Response.json({ success: true, result: [] }));
    return Promise.resolve(Response.json({ success: true, result: { id: 'fixture-record' } }));
  });
  const result = await call('databases/' + database.id + '/domain', 'POST', { hostname, dns: true });
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.domains[hostname], { target: 'database:' + database.id, record: 'fixture-record' });
  assert.deepEqual(calls.at(-1).body.config.ingress, [
    { hostname, service: f.app.publicOrigin }, { service: 'http_status:404' }
  ]);
  const { data: project } = await call('projects', 'POST', { name: 'Custom app', type: 'static' });
  const projectRoute = 'projects/' + project.id + '/domain';
  assert.equal((await call(projectRoute, 'POST', { hostname, remove: true })).status, 409);
  const appHostname = 'app.example.org';
  const mapped = await call(projectRoute, 'POST', { hostname: appHostname, target: 'database:' + database.id });
  assert.equal(mapped.status, 200);
  assert.equal(mapped.data.domains[appHostname].target, 'project:' + project.id);
});

test('project source, successful release, crash recovery, failed deploy, rollback and log redaction', async t => {
  const f = await fixture(t);
  const call = await f.authenticate();
  const config = { name: 'Test', type: 'node', health: '/healthz', backoff: 1, secrets: { DEMO_SECRET: 'redact-example-value' } };
  const { data: project } = await call('projects', 'POST', config);
  const base = 'projects/' + project.id;
  const write = content => call(base + '/files', 'POST', { action: 'write', path: 'server.mjs', content });
  assert.equal((await call(base + '/files', 'POST', { action: 'write', path: '../control.sqlite', content: 'no' })).status, 400);
  assert.equal((await write(sample + '\nconsole.log(process.env.DEMO_SECRET);')).status, 200);
  async function deploy(status) {
    const result = await call(base + '/action', 'POST', { action: 'deploy' });
    assert.equal(result.status, 202);
    return until(async () => {
      const release = (await call(base + '/releases')).data.find(item => item.id === result.data.release);
      return release?.status === status && release;
    });
  }
  const first = await deploy('ready');
  const state = async () => (await call('projects')).data[0];
  const original = await state();
  assert.equal((await fetch('http://127.0.0.1:' + original.port + '/healthz')).status, 200);
  await until(async () => (await call(base + '/logs')).data.log.includes('[REDACTED]'));
  assert.doesNotMatch((await call(base + '/logs')).data.log, /redact-example-value/);
  await write('process.exit(1);');
  await deploy('failed');
  assert.equal((await state()).current, first.id);
  assert.equal((await state()).port, original.port);
  await write(sample.replace('sample is online', 'second release'));
  const second = await deploy('ready');
  assert.notEqual(second.id, first.id);
  assert.equal((await call(base + '/action', 'POST', { action: 'rollback', release: first.id })).status, 200);
  const beforeCrash = await state();
  process.kill(beforeCrash.pid, 'SIGKILL');
  const recovered = await until(async () => {
    const item = await state();
    return item.running && item.pid !== beforeCrash.pid && item;
  });
  assert.equal(recovered.current, first.id);
  await f.restart();
  const resumed = await until(async () => { const item = await state(); return item.running && item; });
  assert.equal(resumed.current, first.id);
  assert.equal((await call(base + '/action', 'POST', { action: 'stop' })).status, 200);
  assert.equal((await state()).running, false);
});

test('built static output through mapped host and management listener separation', async t => {
  const f = await fixture(t);
  const call = await f.authenticate();
  const project = (await call('projects', 'POST', { name: 'Frontend', type: 'vite', build: [process.execPath, 'build.mjs'] })).data;
  const base = 'projects/' + project.id;
  await call(base + '/files', 'POST', { action: 'write', path: 'build.mjs',
    content: 'import {mkdirSync,writeFileSync} from "node:fs"; mkdirSync("dist"); writeFileSync("dist/index.html","<h1>Frontend release</h1>");' });
  await call(base + '/action', 'POST', { action: 'deploy' });
  await until(async () => (await call('projects')).data[0].running);
  f.app.store.set('domains', { 'site.example.org': { target: 'project:' + project.id } });
  const host = { Host: 'site.example.org' };
  // Node fetch rewrites Host, so use the loopback preview entry for the static response.
  const { request } = await import('node:http');
  const response = await new Promise((resolve, reject) => {
    const req = request(f.app.publicOrigin, { headers: host }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(response.status, 200);
  assert.match(response.body, /Frontend release/);
  assert.equal((await fetch(f.app.publicOrigin + '/api/session')).status, 404);
});

test('webhook rejects forged requests and validates the branch of signed pushes', async t => {
  const f = await fixture(t);
  const call = await f.authenticate();
  const project = (await call('projects', 'POST', { name: 'Webhook', type: 'node', repo: 'https://github.com/example/fixture.git' })).data;
  const secret = (await call('projects/' + project.id + '/webhook', 'POST', {})).data.secret;
  const body = { ref: 'refs/heads/other', repository: { html_url: 'https://github.com/example/fixture' } };
  const signature = 'sha256=' + createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');
  const webhook = '/hooks/' + project.id;
  assert.equal((await api(f.app.publicOrigin, webhook, 'POST', body, { 'X-GitHub-Event': 'push', 'X-Hub-Signature-256': 'sha256=bogus' })).status, 403);
  const valid = await api(f.app.publicOrigin, webhook, 'POST', body, { 'X-GitHub-Event': 'push', 'X-Hub-Signature-256': signature });
  assert.equal(valid.status, 200);
  assert.equal(valid.data.skipped, true);
});

test('Wi-Fi sharing serves the selected app at its root and can be disabled', async t => {
  if (!Object.values(networkInterfaces()).flat().some(item => item.family === 'IPv4' && !item.internal &&
      /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(item.address))) return t.skip('No private IPv4 interface');
  const f = await fixture(t);
  const call = await f.authenticate();
  const project = (await call('projects', 'POST', { name: 'Wi-Fi sample', type: 'node', health: '/healthz' })).data;
  const path = 'projects/' + project.id;
  await call(path + '/files', 'POST', { action: 'write', path: 'server.mjs', content: sample });
  await call(path + '/action', 'POST', { action: 'deploy' });
  await until(async () => (await call('projects')).data[0].running);
  assert.equal((await api(f.app.origin, '/api/networking/lan', 'POST', { project: project.id })).status, 401);
  const result = await call('networking/lan', 'POST', { project: project.id });
  assert.equal(result.status, 200);
  assert.ok(result.data.lan.url, result.data.lan.error);
  const url = result.data.lan.url;
  assert.match(await (await fetch(url)).text(), /Running on Skull X PhoneCloud/);
  assert.deepEqual(await (await fetch(url + '/healthz')).json(), { healthy: true });
  assert.equal((await call('networking/lan', 'POST', { project: null })).data.lan.url, null);
  await assert.rejects(fetch(url, { signal: AbortSignal.timeout(2000) }));
});

test('document permissions, validation, two realtime clients, filtered CRUD and encrypted restore', async t => {
  const f = await fixture(t);
  const call = await f.authenticate();
  const db = (await call('databases', 'POST', { name: 'Records' })).data;
  const base = 'databases/' + db.id;
  const external = '/db/' + db.id;
  const documents = external + '/records/tasks';
  assert.equal((await call(base + '/collections', 'POST', { name: 'tasks', fields: { name: { type: 'string', unique: true, required: true } } })).status, 201);
  assert.equal((await api(f.app.publicOrigin, documents, 'GET')).status, 403);
  assert.equal((await api(f.app.publicOrigin, documents, 'POST', { name: 'Example' })).status, 403);
  const read = (await call(base + '/keys', 'POST', { label: 'client', permission: 'read' })).data.key;
  const auth = { Authorization: 'Bearer ' + read };
  assert.equal((await api(f.app.publicOrigin, documents, 'POST', { name: 'Example' }, auth)).status, 403);
  const clients = await Promise.all([1, 2].map(async () => {
    const stream = await fetch(f.app.publicOrigin + external + '/events/tasks', { headers: auth, signal: AbortSignal.timeout(12000) });
    assert.equal(stream.status, 200);
    const reader = stream.body.getReader();
    await reader.read();
    return reader;
  }));
  const result = await call(base + '/records/tasks', 'POST', { name: 'Example' });
  assert.equal(result.status, 200);
  for (const reader of clients) {
    assert.match(Buffer.from((await reader.read()).value).toString(), /event: change[\s\S]*Example/);
    await reader.cancel();
  }
  assert.equal((await call(base + '/records/tasks', 'POST', { name: 'Example' })).status, 409);
  assert.equal((await call(base + '/records/tasks', 'POST', { name: 12 })).status, 400);
  const filtered = await api(f.app.publicOrigin, documents + '?field=name&value=' + encodeURIComponent('"Example"'), 'GET', undefined, auth);
  assert.equal(filtered.data[0].id, result.data.id);
  assert.equal((await call(base + '/records/tasks/' + result.data.id, 'PUT', { name: 'Updated' })).status, 200);
  const file = join(f.parent, 'test.pcbackup');
  const passphrase = 'separate backup fixture secret';
  const archive = await createBackup(f.home, file, passphrase);
  assert.equal(archive.files, 3);
  assert.throws(() => restoreBackup(join(f.parent, 'restored'), file, 'incorrect backup password', true), { status: 400 });
  const restored = join(f.parent, 'restored');
  assert.equal(restoreBackup(restored, file, passphrase, true).databases, 1);
  assert.equal(restoreBackup(restored, file, passphrase, false).databases, 1);
  const recovery = await start({ home: restored, port: 0, publicPort: 0 });
  try {
    const check = await api(recovery.publicOrigin, documents, 'GET', undefined, auth);
    assert.equal(check.data[0].data.name, 'Updated');
  } finally { await recovery.close(); }
  assert.equal((await call(base + '/records/tasks/' + result.data.id, 'DELETE', {})).status, 200);
  const tampered = readFileSync(file);
  tampered[tampered.length - 1] ^= 1;
  writeFileSync(file, tampered);
  assert.throws(() => restoreBackup(restored, file, passphrase, true), { status: 400 });
});
