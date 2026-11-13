import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createReadStream, mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync, renameSync, unlinkSync, rmSync, statSync, appendFileSync } from 'node:fs';
import { join, resolve, relative, extname, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { ensureSpace, HttpError } from '../core/store.mjs';
import { requiredText } from '../core/http.mjs';
import { seal, unseal } from '../security/security.mjs';

const types = new Set(['node', 'python', 'static', 'vite']);
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.woff2': 'font/woff2' };

function inside(root, name) {
  const parts = name.split('/');
  if (name.length > 512 || parts.some(part => !/^[\w.@-]{1,120}$/.test(part) || part.toLowerCase() === '.git' || /[. ]$/.test(part) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new HttpError(400, 'Invalid file path.');
  }
  let path = root;
  for (const part of parts) {
    path = join(path, part);
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (info?.isSymbolicLink()) throw new HttpError(400, 'Symbolic links are not served.');
  }
  return path;
}

function argv(input, label) {
  if (input == null || input === '') return [];
  if (!Array.isArray(input) || input.length > 30 || input.some(item => typeof item !== 'string' || !item || item.length > 2000 || item.includes('\0'))) {
    throw new HttpError(400, `${label} must be a JSON array of executable and argument strings.`);
  }
  return input;
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const socket = createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const { port } = socket.address();
      socket.close(() => resolve(port));
    });
  });
}

export function projects(store) {
  const root = join(store.home, 'projects');
  mkdirSync(root, { recursive: true });
  const active = new Map();
  const busy = new Set();
  const children = new Set();
  const recoveries = new Map();
  const jobs = new Set();
  let closing = false;
  const pathFor = (id, ...parts) => join(root, id, ...parts);
  const save = (id, config) => store.db.prepare('UPDATE projects SET config=? WHERE id=?').run(JSON.stringify(config), id);
  function get(id) {
    const row = store.db.prepare('SELECT config FROM projects WHERE id=?').get(id);
    if (!row) throw new HttpError(404, 'Project not found.');
    return JSON.parse(row.config);
  }
  const history = id => store.db.prepare('SELECT info FROM releases WHERE project=? ORDER BY rowid DESC LIMIT 50').all(id).map(row => JSON.parse(row.info));
  function releaseInfo(id, release) {
    const row = store.db.prepare('SELECT info FROM releases WHERE project=? AND id=?').get(id, release);
    return row && JSON.parse(row.info);
  }
  const logFile = (id, kind) => pathFor(id, kind + '.log');
  function log(id, kind, value) {
    const file = logFile(id, kind);
    if (statSync(file, { throwIfNoEntry: false })?.size > 1024 * 1024) renameSync(file, file + '.1');
    appendFileSync(file, value, { mode: 0o600 });
  }
  function publicInfo(id, config = get(id)) {
    const { secrets, webhook, ...visible } = config;
    const state = active.get(id);
    return { id, ...visible, secretNames: Object.keys(unseal(store.key, secrets)), webhookEnabled: Boolean(webhook),
      running: Boolean(state), port: state?.port ?? null, pid: state?.child?.pid ?? null, uptime: state ? (Date.now() - state.started) / 1000 : null,
      healthStatus: state?.health ?? null, busy: busy.has(id) };
  }
  function configure(input, previous = {}) {
    const name = requiredText(input.name, 'project name', 70);
    const type = input.type;
    if (!types.has(type)) throw new HttpError(400, 'Unsupported project type.');
    const repo = input.repo || '';
    if (typeof repo !== 'string' || repo && !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?$/.test(repo)) throw new HttpError(400, 'Use a public GitHub HTTPS repository URL.');
    const branch = input.branch || 'main';
    if (typeof branch !== 'string' || !/^[A-Za-z0-9][\w./-]{0,127}$/.test(branch) || branch.includes('..')) throw new HttpError(400, 'Invalid branch.');
    const output = input.output || (type === 'vite' ? 'dist' : configOutput(type, repo));
    if (output !== '.') inside(root, requiredText(output, 'output path'));
    if (repo && ['static', 'vite'].includes(type) && output === '.') throw new HttpError(400, 'Choose a public output subfolder for GitHub sources.');
    const health = input.health || '/';
    if (typeof health !== 'string' || !/^\/[\w/-]{0,180}$/.test(health) || health.startsWith('//')) throw new HttpError(400, 'Use a relative HTTP health path such as /healthz.');
    const backoff = Number(input.backoff ?? previous.backoff ?? 2);
    if (!Number.isInteger(backoff) || backoff < 1 || backoff > 60) throw new HttpError(400, 'Restart backoff must be 1 to 60 seconds.');
    const settings = { ...previous, name, type, repo, branch, output, health, backoff,
      install: argv(input.install, 'Install command'), build: argv(input.build, 'Build command'), start: argv(input.start, 'Start command') };
    if (['node', 'python'].includes(type) && !settings.start.length) settings.start = type === 'node' ? ['node', 'server.mjs'] : ['python', 'app.py'];
    if (input.secrets !== undefined) {
      if (!input.secrets || typeof input.secrets !== 'object' || Array.isArray(input.secrets) || Object.keys(input.secrets).length > 40 ||
          Object.entries(input.secrets).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(key) || typeof value !== 'string' || value.length > 4000 || /[\x00\r\n]/.test(value))) {
        throw new HttpError(400, 'Secrets must be a JSON object with valid environment variable names and single-line string values.');
      }
      settings.secrets = seal(store.key, input.secrets);
    }
    return settings;
  }
  function configOutput(type, repo) {
    if (type === 'static' && repo) throw new HttpError(400, 'For GitHub static sites, specify a public output folder.');
    return '.';
  }
  function saveRelease(id, release, info) {
    store.db.prepare('INSERT INTO releases VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET info=excluded.info').run(release, id, JSON.stringify(info));
  }
  function command(id, args, cwd, extraEnv, kind) {
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      /^(PATH|HOME|PREFIX|TMPDIR|TMP|TEMP|USER|LANG|LC_.*|SystemRoot|COMSPEC|APPDATA|LOCALAPPDATA|LD_PRELOAD)$/i.test(key)));
    const child = spawn(args[0], args.slice(1), {
      cwd, env: { ...environment, GIT_TERMINAL_PROMPT: '0', ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true
    });
    children.add(child);
    const sensitive = Object.values(unseal(store.key, get(id).secrets)).filter(Boolean).sort((a, b) => b.length - a.length);
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8');
      let pending = '';
      function write(line) {
        for (const value of sensitive) line = line.split(value).join('[REDACTED]');
        try { log(id, kind, line); } catch { console.error('Project log write failed.'); }
      }
      stream.on('data', chunk => {
        pending += chunk;
        const boundary = pending.lastIndexOf('\n');
        if (boundary !== -1) { write(pending.slice(0, boundary + 1)); pending = pending.slice(boundary + 1); }
        if (pending.length > 64000) pending = '';
      });
      stream.on('end', () => { if (pending) write(pending + '\n'); });
    }
    const done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(new Error(`Process exited with status ${code ?? 'signal'}.`)));
    }).finally(() => children.delete(child));
    done.catch(() => {});
    return { child, done };
  }
  function kill(child, signal = 'SIGTERM') {
    if (!child?.pid) return;
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) { if (error.code !== 'ESRCH') console.error('Could not stop project process.'); }
  }
  async function run(id, args, cwd, env, timeout = 300000) {
    if (!args.length) return;
    const { child, done } = command(id, args, cwd, env, 'build');
    const timer = setTimeout(() => kill(child, 'SIGKILL'), timeout);
    try { await done; } finally { clearTimeout(timer); }
  }
  function dirSize(path) {
    let bytes = 0;
    for (const item of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, item.name);
      if (item.isDirectory()) bytes += dirSize(full);
      if (item.isFile()) bytes += statSync(full).size;
    }
    return bytes;
  }
  async function prepare(id, release, config) {
    const cwd = pathFor(id, 'releases', release);
    const env = unseal(store.key, config.secrets);
    if (config.repo) await run(id, ['git', '-c', 'core.hooksPath=/dev/null', 'clone', '--depth', '1', '--branch', config.branch, '--', config.repo, cwd], pathFor(id), {});
    else {
      const { cpSync } = await import('node:fs');
      cpSync(pathFor(id, 'source'), cwd, { recursive: true, verbatimSymlinks: true });
    }
    let commit = null;
    if (config.repo) commit = readFileSync(join(cwd, '.git', 'HEAD'), 'utf8').startsWith('ref:')
      ? await new Promise((resolve, reject) => {
        const child = spawn('git', ['rev-parse', 'HEAD'], { cwd, windowsHide: true });
        let data = '';
        child.stdout.on('data', chunk => { data += chunk; });
        child.once('error', reject);
        child.once('close', code => code === 0 && /^[a-f0-9]{40,64}$/.test(data.trim()) ? resolve(data.trim()) : reject(new Error('Commit lookup failed.')));
      }) : readFileSync(join(cwd, '.git', 'HEAD'), 'utf8').trim();
    await run(id, config.install, cwd, env);
    await run(id, config.build, cwd, env);
    if (dirSize(cwd) > 512 * 1024 * 1024) throw new Error('Release exceeds 512 MiB.');
    return commit;
  }
  async function launch(id, release, config) {
    if (closing) throw new Error('PhoneCloud is shutting down.');
    const cwd = pathFor(id, 'releases', release);
    const started = Date.now();
    if (['static', 'vite'].includes(config.type)) {
      const staticRoot = config.output === '.' ? cwd : inside(cwd, config.output);
      if (!lstatSync(inside(staticRoot, 'index.html'), { throwIfNoEntry: false })?.isFile()) throw new Error('Build output must contain index.html.');
      return { staticRoot, release, started, health: 'healthy' };
    }
    const port = await availablePort();
    if (closing) throw new Error('PhoneCloud is shutting down.');
    const env = { ...unseal(store.key, config.secrets), HOST: '127.0.0.1', PORT: String(port), PHONECLOUD_DATA_DIR: pathFor(id, 'data') };
    const proc = command(id, config.start, cwd, env, 'runtime');
    let exited = false;
    proc.done.finally(() => { exited = true; }).catch(() => {});
    try {
      for (let attempt = 0; attempt < 40 && !exited && !closing; attempt++) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}${config.health}`, { signal: AbortSignal.timeout(800), redirect: 'manual' });
          await response.body?.cancel();
          if (response.ok && !exited) return { ...proc, port, release, started, health: 'healthy' };
        } catch { /* Service is still starting. */ }
        await sleep(250);
      }
    } catch (error) { kill(proc.child, 'SIGKILL'); throw error; }
    kill(proc.child, 'SIGKILL');
    throw new Error('Application did not pass its HTTP health check.');
  }
  function stop(id) {
    clearTimeout(recoveries.get(id));
    recoveries.delete(id);
    const state = active.get(id);
    active.delete(id);
    kill(state?.child, 'SIGTERM');
    if (state?.child) {
      const timer = setTimeout(() => kill(state.child, 'SIGKILL'), 4000);
      state.done.finally(() => clearTimeout(timer)).catch(() => {});
      timer.unref();
    }
  }
  function activate(id, state, failures = 0) {
    stop(id);
    active.set(id, state);
    state.failures = failures;
    if (state.done) state.done.finally(() => {
      if (active.get(id) !== state) return;
      active.delete(id);
      if (Date.now() - state.started > 60000) failures = 0;
      recover(id, failures);
    }).catch(() => {});
  }
  function recover(id, failures = 0) {
    if (closing) return;
    const config = get(id);
    if (!config.enabled || !config.current) return;
    const timer = setTimeout(() => {
      recoveries.delete(id);
      if (busy.has(id)) return recover(id, failures);
      const release = releaseInfo(id, config.current);
      if (!release?.runtime) return;
      background(id, async () => {
        try { activate(id, await launch(id, config.current, { ...release.runtime, secrets: get(id).secrets }), failures + 1); }
        catch { recover(id, failures + 1); }
      });
    }, Math.min(60000, (config.backoff || 2) * 1000 * 2 ** Math.min(failures, 6)));
    recoveries.set(id, timer);
  }
  function background(id, task) {
    if (closing || busy.has(id)) throw new HttpError(409, 'A project operation is already running.');
    busy.add(id);
    const job = Promise.resolve().then(task).catch(() => console.error('Project operation failed.'))
      .finally(() => { busy.delete(id); jobs.delete(job); });
    jobs.add(job);
  }
  function deploy(id) {
    const config = get(id);
    if (busy.size >= 2) throw new HttpError(409, 'Wait for another project operation to finish.');
    ensureSpace(root, 128 * 1024 * 1024);
    const release = randomUUID();
    const { type, start, output, health } = config;
    const runtime = { type, start, output, health };
    background(id, async () => {
      const info = { id: release, time: Date.now(), status: 'building', runtime };
      saveRelease(id, release, info);
      let candidate;
      try {
        info.commit = await prepare(id, release, config);
        candidate = await launch(id, release, config);
        store.transaction(() => {
          saveRelease(id, release, { ...info, status: 'ready' });
          save(id, { ...get(id), current: release, enabled: true });
          store.audit('Project deployed ' + id);
        });
        activate(id, candidate);
      } catch (error) {
        kill(candidate?.child, 'SIGKILL');
        saveRelease(id, release, { ...info, status: 'failed', error: error.message });
        rmSync(pathFor(id, 'releases', release), { recursive: true, force: true });
      }
    });
    return { release };
  }
  async function action(id, action, release) {
    const config = get(id);
    if (busy.has(id)) throw new HttpError(409, 'Wait for the running project operation.');
    if (action === 'deploy') return deploy(id);
    if (action === 'stop') {
      save(id, { ...config, enabled: false });
      stop(id);
      return publicInfo(id);
    }
    if (action === 'start' && active.has(id)) return publicInfo(id);
    if (!['start', 'restart', 'rollback'].includes(action)) throw new HttpError(400, 'Invalid project action.');
    const target = releaseInfo(id, (action === 'rollback' ? release : config.current) || '');
    if (target?.status !== 'ready') throw new HttpError(409, 'Choose a successful release.');
    busy.add(id);
    try {
      let state;
      try { state = await launch(id, target.id, { ...target.runtime, secrets: config.secrets }); }
      catch { throw new HttpError(409, 'The release failed its health check. View runtime logs.'); }
      save(id, { ...get(id), current: target.id, enabled: true });
      activate(id, state);
      return publicInfo(id);
    } finally { busy.delete(id); }
  }
  function files(id, body) {
    get(id);
    if (busy.has(id)) throw new HttpError(409, 'Wait for the running project operation.');
    const root = pathFor(id, body?.area === 'data' ? 'data' : 'source');
    if (lstatSync(root).isSymbolicLink()) throw new HttpError(400, 'Symbolic links are not supported.');
    if (!body?.path && !body?.action) return readdirSync(root, { recursive: true, withFileTypes: true }).filter(item => item.isFile())
      .slice(0, 1000).map(item => relative(root, join(item.parentPath, item.name)).split(sep).join('/'));
    if (typeof body.path !== 'string' || !body.path) throw new HttpError(400, 'Enter a relative file path.');
    const path = inside(root, body.path);
    if (body.action === 'delete') {
      if (!lstatSync(path, { throwIfNoEntry: false })?.isFile()) throw new HttpError(404, 'File not found.');
      unlinkSync(path);
      return { ok: true };
    }
    if (body.action === 'write') {
      if (typeof body.content !== 'string' || body.encoding === 'base64' && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.content)) throw new HttpError(400, 'Invalid file content.');
      const data = Buffer.from(body.content, body.encoding === 'base64' ? 'base64' : 'utf8');
      if (data.length > 2 * 1024 * 1024 || dirSize(root) - (statSync(path, { throwIfNoEntry: false })?.size || 0) + data.length > 64 * 1024 * 1024) throw new HttpError(413, 'File or project storage quota exceeded.');
      ensureSpace(root);
      mkdirSync(resolve(path, '..'), { recursive: true });
      const temporary = path + '.' + randomUUID();
      try { writeFileSync(temporary, data, { flag: 'wx' }); renameSync(temporary, path); }
      finally { rmSync(temporary, { force: true }); }
      return { ok: true };
    }
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat?.isFile()) throw new HttpError(404, 'File not found.');
    if (stat.size > 2 * 1024 * 1024) throw new HttpError(413, 'File is too large for this operation.');
    return { content: readFileSync(path).toString(body.encoding === 'base64' ? 'base64' : 'utf8') };
  }
  function staticResponse(state, req, res, pathname) {
    if (!['GET', 'HEAD'].includes(req.method)) throw new HttpError(405, 'Static projects support GET and HEAD.');
    const name = decodeURIComponent(pathname.slice(1)) || 'index.html';
    if (name.split('/').some(part => part.startsWith('.'))) throw new HttpError(404, 'File not found.');
    let path = inside(state.staticRoot, name.replace(/\/$/, '') || 'index.html');
    if (lstatSync(path, { throwIfNoEntry: false })?.isDirectory()) path = inside(state.staticRoot, name.replace(/\/$/, '') + '/index.html');
    if (!lstatSync(path, { throwIfNoEntry: false })?.isFile() && !extname(name)) path = inside(state.staticRoot, 'index.html');
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat?.isFile()) throw new HttpError(404, 'File not found.');
    res.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream', 'Content-Length': stat.size });
    if (req.method === 'HEAD') return res.end();
    const stream = createReadStream(path);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }
  let healthRunning = false;
  const checks = setInterval(async () => {
    if (healthRunning || closing) return;
    healthRunning = true;
    try {
      for (const [id, state] of active) {
        if (!state.port || busy.has(id) || closing) continue;
        const release = releaseInfo(id, state.release);
        if (!release) continue;
        let healthy = false;
        try {
          const response = await fetch(`http://127.0.0.1:${state.port}${release.runtime.health}`, { signal: AbortSignal.timeout(1800), redirect: 'manual' });
          await response.body?.cancel();
          healthy = response.ok;
        } catch { /* Health check timed out or the socket is unavailable. */ }
        if (closing || active.get(id) !== state) continue;
        state.health = healthy ? 'healthy' : 'unhealthy';
        state.unhealthyCount = healthy ? 0 : (state.unhealthyCount || 0) + 1;
        if (state.unhealthyCount >= 3) {
          stop(id);
          recover(id, state.failures);
          store.audit('Project restarted after failing health checks ' + id);
        }
      }
    } catch { console.error('Could not complete project health checks.'); }
    finally { healthRunning = false; }
  }, 15000);
  checks.unref();
  return {
    list: () => store.db.prepare('SELECT id,config FROM projects ORDER BY rowid').all().map(row => publicInfo(row.id, JSON.parse(row.config))),
    get: publicInfo, history, action, files, deploy,
    runtime: id => active.get(id),
    privateConfig: get,
    staticResponse,
    create(input) {
      if (store.db.prepare('SELECT count(*) AS n FROM projects').get().n >= 32) throw new HttpError(409, 'Project limit reached.');
      const config = configure(input);
      const id = randomUUID();
      for (const sub of ['source', 'data', 'releases']) mkdirSync(pathFor(id, sub), { recursive: true });
      store.db.prepare('INSERT INTO projects VALUES (?,?)').run(id, JSON.stringify(config));
      store.audit('Project created ' + id);
      return publicInfo(id, config);
    },
    update(id, input) {
      if (busy.has(id)) throw new HttpError(409, 'Wait for the running project operation.');
      const config = configure(input, get(id));
      save(id, config);
      store.audit('Project configuration updated ' + id);
      return publicInfo(id, config);
    },
    webhook(id, encrypted) { save(id, { ...get(id), webhook: encrypted }); },
    remove(id) {
      get(id);
      if (busy.has(id)) throw new HttpError(409, 'Wait for the running project operation.');
      stop(id);
      store.db.prepare('DELETE FROM projects WHERE id=?').run(id);
      store.audit('Project removed ' + id);
      // Keep files recoverable outside the active project list.
    },
    logs(id, kind) {
      get(id);
      if (!['build', 'runtime'].includes(kind)) throw new HttpError(400, 'Invalid log type.');
      try { return readFileSync(logFile(id, kind), 'utf8').slice(-64000); }
      catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
    },
    resume() {
      for (const row of store.db.prepare('SELECT id FROM projects').all()) {
        for (const release of history(row.id).filter(item => item.status === 'building')) saveRelease(row.id, release.id, { ...release, status: 'failed', error: 'Build interrupted by restart.' });
        recover(row.id);
      }
    },
    async close() {
      closing = true;
      clearInterval(checks);
      for (const id of [...active.keys(), ...recoveries.keys()]) stop(id);
      for (const child of children) kill(child, 'SIGKILL');
      await Promise.allSettled(jobs);
    }
  };
}
