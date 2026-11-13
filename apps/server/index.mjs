import { createServer } from 'node:http';
import { createReadStream, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError, openStore } from '../../packages/core/store.mjs';
import { json, jsonBody } from '../../packages/core/http.mjs';
import { digest, equal, passwordHash, rateLimiter, seal, strongPassword, token, unseal, verifyPassword } from '../../packages/security/security.mjs';
import { monitoring } from '../../packages/monitoring/monitoring.mjs';
import { projects } from '../../packages/deployments/projects.mjs';
import { documentService } from '../../packages/database/documents.mjs';
import { tunnels } from '../../packages/tunnels/tunnels.mjs';
import { backupJobs, restoreBackup } from '../../packages/core/backups.mjs';

const dashboard = new URL('../dashboard/', import.meta.url);
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/cloud.js', ['cloud.js', 'text/javascript; charset=utf-8']]
]);
const sessionAge = 12 * 60 * 60 * 1000;
const usernameValid = value => typeof value === 'string' && /^[a-zA-Z0-9_.-]{3,40}$/.test(value);

export async function start({ home = process.env.PHONECLOUD_HOME || join(homedir(), '.phonecloud', 'data'),
  port = Number(process.env.PHONECLOUD_PORT || 8765), publicPort = Number(process.env.PHONECLOUD_PUBLIC_PORT || 8766), interval } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid dashboard port.');
  if (process.platform !== 'win32') process.umask(0o077);
  const store = openStore(home);
  const setupPath = join(home, 'setup-code');
  const removeSetup = () => {
    try { unlinkSync(setupPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
  if (store.get('admin')) removeSetup();
  else {
    try { writeFileSync(setupPath, token(18) + '\n', { mode: 0o600, flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const monitor = monitoring(store, interval);
  const hosting = projects(store);
  const documents = documentService(store);
  const network = tunnels(store, hosting, documents, monitor, publicPort);
  const backups = backupJobs(store);
  const schedule = setInterval(async () => {
    const settings = store.get('backupSchedule');
    if (!settings || Date.now() < settings.next) return;
    store.set('backupSchedule', { ...settings, next: Date.now() + settings.hours * 3600000 });
    try { await backups.run(unseal(store.key, settings.password).value, settings.retention); }
    catch { store.audit('Scheduled backup failed'); }
  }, 60000);
  schedule.unref();
  const authLimit = rateLimiter(6, 60000);
  const requestsLimit = rateLimiter(240, 60000);
  let origin;
  function session(req) {
    const id = req.headers.cookie?.match(/(?:^|;\s*)phonecloud=([\w-]{43})(?:;|$)/)?.[1];
    return id && store.db.prepare('SELECT * FROM sessions WHERE token=? AND expires>?').get(digest(id), Date.now());
  }
  function issue(res) {
    const id = token();
    const csrf = token();
    store.db.prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());
    store.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(digest(id), csrf, Date.now() + sessionAge);
    res.setHeader('Set-Cookie', `phonecloud=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionAge / 1000}`);
    return csrf;
  }
  const server = createServer({ requestTimeout: 20000, headersTimeout: 10000 }, async (req, res) => {
    const began = performance.now();
    res.on('finish', () => monitor.record(res.statusCode, performance.now() - began));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      if (req.headers.host !== new URL(origin).host || req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Open the dashboard using its local URL.');
      const url = new URL(req.url, origin);
      if (url.origin !== origin) throw new HttpError(400, 'Invalid request target.');
      const method = req.method;
      const path = url.pathname;
      if (method === 'GET' && path === '/healthz') return json(res, { status: 'ok' });
      if (method === 'GET' && assets.has(path)) {
        const [file, type] = assets.get(path);
        res.writeHead(200, { 'Content-Type': type });
        return res.end(readFileSync(new URL(file, dashboard)));
      }
      requestsLimit(req.socket.remoteAddress);
      const admin = store.get('admin');
      const current = session(req);
      if (method === 'GET' && path === '/api/session') return json(res, { setup: !admin, user: current ? admin.username : null, csrf: current?.csrf });
      if (!['GET', 'HEAD'].includes(method) && req.headers.origin !== origin) throw new HttpError(403, 'Origin check failed.');
      if (method === 'POST' && path === '/api/setup') {
        if (admin) throw new HttpError(409, 'Admin setup is complete.');
        authLimit('setup');
        const input = await jsonBody(req, 4096);
        if (!equal(input.code, readFileSync(setupPath, 'utf8').trim())) throw new HttpError(403, 'Invalid setup code.');
        if (!usernameValid(input.username)) throw new HttpError(400, 'Use 3 to 40 letters, numbers, periods, hyphens or underscores.');
        strongPassword(input.password);
        const password = await passwordHash(input.password);
        if (store.get('admin')) throw new HttpError(409, 'Admin setup is complete.');
        store.set('admin', { username: input.username, password });
        removeSetup();
        store.audit('Administrator account created');
        return json(res, { user: input.username, csrf: issue(res) }, 201);
      }
      if (method === 'POST' && path === '/api/login') {
        authLimit('login');
        const input = await jsonBody(req, 4096);
        const valid = await verifyPassword(input.password, admin?.password);
        if (!valid || !equal(input.username, admin?.username)) {
          store.audit('Administrator login rejected');
          throw new HttpError(401, 'Invalid username or password.');
        }
        if (store.get('admin')?.password !== admin.password) throw new HttpError(409, 'Credentials changed. Sign in again.');
        if (current) store.db.prepare('DELETE FROM sessions WHERE token=?').run(current.token);
        store.audit('Administrator signed in');
        return json(res, { user: admin.username, csrf: issue(res) });
      }
      if (!current) throw new HttpError(401, 'Sign in to continue.');
      if (method !== 'GET' && !equal(current.csrf, req.headers['x-csrf-token'])) throw new HttpError(403, 'Session verification failed.');
      if (method === 'POST' && path === '/api/logout') {
        store.db.prepare('DELETE FROM sessions WHERE token=?').run(current.token);
        res.setHeader('Set-Cookie', 'phonecloud=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        return json(res, { ok: true });
      }
      if (method === 'POST' && path === '/api/password') {
        authLimit('password');
        const input = await jsonBody(req, 4096);
        strongPassword(input.password);
        if (!(await verifyPassword(input.current, admin.password))) throw new HttpError(403, 'Current password is incorrect.');
        const password = await passwordHash(input.password);
        if (store.get('admin')?.password !== admin.password) throw new HttpError(409, 'Credentials changed. Sign in again.');
        store.transaction(() => {
          store.set('admin', { ...admin, password });
          store.db.exec('DELETE FROM sessions');
          store.audit('Administrator password changed');
        });
        return json(res, { csrf: issue(res) });
      }
      if (method === 'GET' && path === '/api/overview') {
        const projects = hosting.list();
        return json(res, { sample: monitor.latest(), pid: process.pid, runtime: process.version, platform: process.platform, architecture: process.arch,
          projects: projects.length, running: projects.filter(item => item.running).length, realtime: documents.count(), databaseCount: documents.list().length });
      }
      if (method === 'GET' && path === '/api/metrics') {
        const hours = Number(url.searchParams.get('hours') || 1);
        if (![1, 6, 24, 168].includes(hours)) throw new HttpError(400, 'Invalid monitoring range.');
        return json(res, { sample: monitor.latest(), history: monitor.history(hours) });
      }
      if (method === 'GET' && path === '/api/audit') return json(res, store.db.prepare('SELECT time,action FROM audit ORDER BY id DESC LIMIT 100').all());
      const [area, id, operation, ...parts] = path.split('/').slice(2);
      if (area === 'projects') {
        if (!id && method === 'GET') return json(res, hosting.list());
        if (!id && method === 'POST') return json(res, hosting.create(await jsonBody(req)), 201);
        if (!operation && method === 'PUT') return json(res, hosting.update(id, await jsonBody(req)));
        if (!operation && method === 'DELETE') { hosting.remove(id); return json(res, { ok: true }); }
        if (operation === 'releases' && method === 'GET') return json(res, hosting.history(id));
        if (operation === 'logs' && method === 'GET') return json(res, { log: hosting.logs(id, url.searchParams.get('kind') || 'runtime') });
        if (operation === 'files' && method === 'POST') return json(res, hosting.files(id, await jsonBody(req, 3 * 1024 * 1024)));
        if (operation === 'action' && method === 'POST') {
          const input = await jsonBody(req);
          return json(res, await hosting.action(id, input.action, input.release), input.action === 'deploy' ? 202 : 200);
        }
        if (operation === 'webhook' && method === 'POST') {
          const input = await jsonBody(req);
          const secret = input.disable ? null : token();
          hosting.webhook(id, secret && seal(store.key, { secret }));
          store.audit('Project webhook changed ' + id);
          return json(res, { secret });
        }
      }
      if (area === 'databases') {
        if (!id && method === 'GET') return json(res, documents.list());
        if (!id && method === 'POST') return json(res, documents.create(await jsonBody(req)), 201);
        if (id) return await documents.admin(id, [operation, ...parts], req, res, url.searchParams);
      }
      if (area === 'networking') return await network.admin([id, operation, ...parts], req, res, url.searchParams);
      if (area === 'backups') {
        const settings = store.get('backupSchedule');
        if (!id && method === 'GET') return json(res, { files: backups.list(), schedule: settings && { hours: settings.hours, retention: settings.retention, next: settings.next } });
        if (id === 'create' && method === 'POST') return json(res, await backups.run((await jsonBody(req)).password), 201);
        if (id === 'schedule' && method === 'POST') {
          const input = await jsonBody(req);
          if (input.disable) store.set('backupSchedule', null);
          else {
            const { hours, retention, password } = input;
            if (!Number.isInteger(hours) || hours < 1 || hours > 168 || !Number.isInteger(retention) || retention < 1 || retention > 20 ||
                typeof password !== 'string' || password.length < 16 || password.length > 256) throw new HttpError(400, 'Choose a valid interval, retention and passphrase.');
            store.set('backupSchedule', { hours, retention, next: Date.now() + hours * 3600000, password: seal(store.key, { value: password }) });
          }
          store.audit('Backup schedule updated');
          return json(res, { ok: true });
        }
        if (backups.list().some(item => item.name === id)) {
          const file = join(backups.dir, id);
          if (method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="' + id + '"' });
            const stream = createReadStream(file);
            stream.on('error', () => res.destroy());
            res.on('close', () => stream.destroy());
            return stream.pipe(res);
          }
          if (method === 'POST' && operation === 'verify') {
            return json(res, restoreBackup(store.home, file, (await jsonBody(req)).password, true));
          }
        }
      }
      if (method === 'GET' && path === '/api/diagnostics') {
        return json(res, { node: process.version, sqlite: store.db.prepare('SELECT sqlite_version() AS version').get().version,
          platform: process.platform, arch: process.arch, sample: monitor.latest(), projects: hosting.list().length, databases: documents.list().length });
      }
      throw new HttpError(404, 'Resource not found.');
    } catch (error) {
      if (res.headersSent) return res.destroy();
      if (!(error instanceof HttpError)) console.error('Request failed:', error.code || error.name);
      json(res, { error: error instanceof HttpError ? error.message : 'The operation failed. Check service logs.' }, error instanceof HttpError ? error.status : 500);
    }
  });
  try {
    await network.listen();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  } catch (error) {
    clearInterval(schedule);
    await network.close();
    documents.close();
    monitor.close();
    store.db.close();
    throw error;
  }
  origin = `http://127.0.0.1:${server.address().port}`;
  hosting.resume();
  return {
    origin, store, monitor, publicOrigin: network.config().origin,
    async close() {
      clearInterval(schedule);
      monitor.close();
      documents.disconnect();
      await network.close();
      await new Promise(resolve => server.close(resolve));
      await hosting.close();
      await backups.close();
      documents.close();
      store.db.close();
    }
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const app = await start();
  console.log(`Skull X PhoneCloud ready at ${app.origin}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void app.close().then(() => process.exit(0)); });
}
