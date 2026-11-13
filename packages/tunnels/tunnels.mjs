import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { createServer, request } from 'node:http';
import { isIP } from 'node:net';
import { HttpError } from '../core/store.mjs';
import { json, jsonBody } from '../core/http.mjs';
import { createHmac } from 'node:crypto';
import { equal, seal, token, unseal } from '../security/security.mjs';

const hostnamePattern = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const uuidPattern = /^[a-f0-9-]{36}$/;
const hexId = /^[a-f0-9]{32}$/;

export function tunnels(store, projects, documents, monitor, port = 8766) {
  let quick;
  let named;
  let quickUrl;
  let quickStatus = 'stopped';
  let closed = false;
  let reconnect;
  let origin;
  let changing = false;
  const domainMap = () => store.get('domains') || {};
  const credentials = () => unseal(store.key, store.get('cloudflare'));
  function config() {
    const { account, id, zone } = credentials();
    return { origin, domains: domainMap(), account, id, zone, namedRunning: Boolean(named), quickUrl: quickUrl || null, quickRunning: Boolean(quick), quickStatus };
  }
  function launch(args, env, handle) {
    const child = spawn('cloudflared', args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8');
      if (handle) stream.on('data', handle);
      else stream.resume();
    }
    child.on('error', () => console.error('Could not launch cloudflared. Install it with pkg install cloudflared.'));
    return child;
  }
  function runNamed() {
    const { connector } = credentials();
    if (!connector || !origin || closed) return;
    clearTimeout(reconnect);
    const previous = named;
    named = launch(['tunnel', '--no-autoupdate', 'run'], { TUNNEL_TOKEN: connector });
    previous?.kill();
    const process = named;
    const exited = () => {
      if (named !== process) return;
      named = null;
      if (!closed) reconnect = setTimeout(runNamed, 15000);
    };
    process.once('close', exited);
  }
  async function cf(path, method = 'GET', body, supplied) {
    const { apiToken } = supplied || credentials();
    if (!apiToken) throw new HttpError(409, 'Connect Cloudflare first.');
    let response;
    let result;
    try {
      response = await fetch('https://api.cloudflare.com/client/v4' + path, {
        method, redirect: 'error', headers: { Authorization: 'Bearer ' + apiToken, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(12000)
      });
      result = await response.json();
    } catch { throw new HttpError(502, 'Cloudflare API is unreachable.'); }
    if (!response.ok || !result.success) throw new HttpError(502, 'Cloudflare rejected the request. Check token permissions and resource IDs.');
    return result.result;
  }
  const cfPath = ({ account, id }) => `/accounts/${account}/cfd_tunnel${id ? '/' + id : ''}`;
  async function connect(input) {
    if (credentials().id) throw new HttpError(409, 'A tunnel is already connected.');
    const { account, zone, apiToken } = input;
    let { id } = input;
    if (typeof account !== 'string' || !hexId.test(account) || typeof zone !== 'string' || zone && !hexId.test(zone) ||
        typeof apiToken !== 'string' || !/^[\w-]{20,200}$/.test(apiToken) || typeof id !== 'string' || id && !uuidPattern.test(id)) throw new HttpError(400, 'Invalid Cloudflare credentials or IDs.');
    const next = { account, zone, apiToken };
    if (!id) {
      const result = await cf(cfPath(next), 'POST', { name: 'Skull-X-PhoneCloud-' + token(5), config_src: 'cloudflare' }, next);
      id = result.id;
    }
    next.id = id;
    const metadata = await cf(cfPath(next), 'GET', undefined, next);
    if (metadata.config_src !== 'cloudflare') throw new HttpError(400, 'Use a remotely managed tunnel.');
    next.connector = await cf(cfPath(next) + '/token', 'GET', undefined, next);
    if (typeof next.connector !== 'string' || !next.connector) throw new HttpError(502, 'Cloudflare returned no connector token.');
    store.set('cloudflare', seal(store.key, next));
    store.audit('Cloudflare tunnel connected');
    runNamed();
  }
  function routeTarget(value) {
    if (typeof value !== 'string' || !/^(project|database):[a-f0-9-]{36}$/.test(value)) throw new HttpError(400, 'Choose a project or database target.');
    const [type, id] = value.split(':');
    if (type === 'project') projects.get(id);
    else documents.inspect(id);
    return value;
  }
  async function domain(input) {
    const hostname = typeof input.hostname === 'string' ? input.hostname.trim().toLowerCase() : '';
    if (!hostnamePattern.test(hostname) || isIP(hostname)) throw new HttpError(400, 'Enter a valid custom hostname.');
    const previous = domainMap();
    const existing = previous[hostname];
    const cloud = credentials();
    if (!cloud.id) throw new HttpError(409, 'Connect a named Cloudflare tunnel first.');
    const configPath = cfPath(cloud) + '/configurations';
    const { config = {} } = await cf(configPath);
    const ingress = config.ingress || [];
    const current = ingress.find(route => route.hostname === hostname);
    if (current && (!existing || current.path || current.service !== origin)) throw new HttpError(409, 'An unrelated tunnel ingress already owns this hostname.');
    if (input.remove && !existing) throw new HttpError(404, 'Hostname is not managed here.');
    const target = input.remove ? null : routeTarget(input.target);
    let record = existing?.record || null;
    let created = false;
    const dnsPath = cloud.zone && `/zones/${cloud.zone}/dns_records`;
    if (input.dns && !input.remove && !record) {
      if (!dnsPath) throw new HttpError(409, 'A Cloudflare zone ID is required for automatic DNS.');
      const found = await cf(dnsPath + '?name=' + encodeURIComponent(hostname));
      if (found.length) throw new HttpError(409, 'DNS already contains a record at this hostname. Use manual DNS to keep it.');
      const result = await cf(dnsPath, 'POST', { type: 'CNAME', name: hostname, content: `${cloud.id}.cfargotunnel.com`, proxied: true, ttl: 1 });
      record = result.id;
      created = true;
    }
    const remaining = ingress.filter(route => route.hostname !== hostname);
    if (target) remaining.unshift({ hostname, service: origin });
    if (!remaining.length || remaining.at(-1).hostname || remaining.at(-1).path) remaining.push({ service: 'http_status:404' });
    try { await cf(configPath, 'PUT', { config: { ...config, ingress: remaining } }); }
    catch (error) {
      if (created) await cf(dnsPath + '/' + record, 'DELETE').catch(() => console.error('A newly created Cloudflare DNS record may need manual cleanup.'));
      throw error;
    }
    if (input.remove && record && dnsPath) {
      try {
        const actual = await cf(dnsPath + '?name=' + encodeURIComponent(hostname));
        if (actual.some(item => item.id === record && item.name === hostname && item.type === 'CNAME' && item.content === `${cloud.id}.cfargotunnel.com`)) {
          await cf(dnsPath + '/' + record, 'DELETE');
        }
      } catch (error) {
        await cf(configPath, 'PUT', { config }).catch(() => console.error('Cloudflare ingress requires reconciliation.'));
        throw error;
      }
    }
    if (target) previous[hostname] = { target, record };
    else delete previous[hostname];
    store.set('domains', previous);
    store.audit('Cloudflare hostname updated');
  }
  async function verify(hostname) {
    if (!Object.hasOwn(domainMap(), hostname)) throw new HttpError(404, 'Unknown hostname.');
    let dns = [];
    try { dns = await lookup(hostname, { all: true }); } catch { /* DNS may still be propagating. */ }
    const status = dns.length ? await fetch(`https://${hostname}/.well-known/phonecloud-route`, {
      redirect: 'error', signal: AbortSignal.timeout(7000)
    }).then(async response => {
      await response.body?.cancel();
      return { code: response.status, route: response.headers.get('x-phonecloud-route') === '1' };
    }).catch(() => null) : null;
    return { dns, status };
  }
  function proxy(id, req, res, url) {
    const state = projects.runtime(id);
    if (!state) throw new HttpError(503, 'Application is stopped or starting.');
    if (state.staticRoot) return projects.staticResponse(state, req, res, url.pathname);
    const headers = { ...req.headers, host: '127.0.0.1:' + state.port };
    const hop = ['connection', 'upgrade', 'proxy-connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'proxy-authenticate', 'proxy-authorization'];
    for (const name of [...hop, ...(headers.connection || '').split(',').map(item => item.trim().toLowerCase())]) delete headers[name];
    // The admin cookie has no port boundary on 127.0.0.1.
    if (headers.cookie) headers.cookie = headers.cookie.split(';').filter(item => !/^\s*phonecloud=/.test(item)).join(';');
    const upstream = request({ host: '127.0.0.1', port: state.port, path: url.pathname + url.search, method: req.method, headers, timeout: 30000 }, response => {
      const outgoing = { ...response.headers };
      for (const name of [...hop, ...(outgoing.connection || '').split(',').map(item => item.trim().toLowerCase())]) delete outgoing[name];
      if (outgoing['set-cookie']) outgoing['set-cookie'] = outgoing['set-cookie'].filter(item => !/^\s*phonecloud=/i.test(item));
      res.writeHead(response.statusCode, outgoing);
      response.on('error', () => res.destroy());
      response.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => { if (!res.headersSent) json(res, { error: 'Application did not respond.' }, 502); else res.destroy(); });
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  }
  const server = createServer({ requestTimeout: 20000, headersTimeout: 10000 }, async (req, res) => {
    const started = performance.now();
    res.on('finish', () => monitor.record(res.statusCode, performance.now() - started, true));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.origin !== 'http://127.0.0.1') throw new HttpError(400, 'Invalid target.');
      const host = req.headers.host?.split(':')[0].toLowerCase();
      const parts = url.pathname.split('/').slice(1);
      const mapped = Object.hasOwn(domainMap(), host) ? domainMap()[host].target : host && quickUrl && new URL(quickUrl).hostname === host ? quick?.target : null;
      if (parts[0] === 'hooks' && req.method === 'POST' && uuidPattern.test(parts[1] || '') && parts.length === 2) {
        const id = parts[1];
        const project = projects.privateConfig(id);
        if (!project.webhook || req.headers['x-github-event'] !== 'push') throw new HttpError(403, 'Webhook unavailable.');
        let size = 0;
        const chunks = [];
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
          size += chunk.length;
          if (size > 1024 * 1024) { req.resume(); throw new HttpError(413, 'Webhook is too large.'); }
          chunks.push(chunk);
        }
        const bytes = Buffer.concat(chunks);
        const signature = 'sha256=' + createHmac('sha256', unseal(store.key, project.webhook).secret).update(bytes).digest('hex');
        if (!equal(signature, req.headers['x-hub-signature-256'])) throw new HttpError(403, 'Invalid webhook signature.');
        let payload;
        try { payload = JSON.parse(bytes); } catch { throw new HttpError(400, 'Invalid webhook payload.'); }
        if (payload?.ref !== 'refs/heads/' + project.branch || !project.repo || payload.deleted ||
          typeof payload.repository?.html_url !== 'string' || project.repo.replace(/\.git$/, '').toLowerCase() !== payload.repository.html_url.toLowerCase()) return json(res, { skipped: true });
        return json(res, projects.deploy(id), 202);
      }
      if (mapped && url.pathname === '/.well-known/phonecloud-route') {
        res.setHeader('X-PhoneCloud-Route', '1');
        return json(res, { ok: true });
      }
      const [type, id] = mapped?.split(':') || [];
      if (type === 'project') return proxy(id, req, res, url);
      if (type === 'database') return await documents.external(id, parts, req, res, url.searchParams);
      if (host === '127.0.0.1' && parts[0] === 'db' && uuidPattern.test(parts[1] || '')) return await documents.external(parts[1], parts.slice(2), req, res, url.searchParams);
      if (host === 'localhost' && parts[0] === 'app' && uuidPattern.test(parts[1] || '')) {
        return proxy(parts[1], req, res, new URL('http://localhost/' + parts.slice(2).join('/') + url.search));
      }
      throw new HttpError(404, 'Route not found.');
    } catch (error) {
      if (res.headersSent) return res.destroy();
      return json(res, { error: error instanceof HttpError ? error.message : 'Request failed.' }, error instanceof HttpError ? error.status : 500);
    }
  });
  return {
    config,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
      origin = 'http://127.0.0.1:' + server.address().port;
      runNamed();
    },
    async admin(parts, req, res, params) {
      if (req.method === 'GET' && !parts[0]) return json(res, config());
      if (req.method === 'GET' && parts[0] === 'verify') return json(res, await verify(params.get('host')));
      if (req.method === 'GET' && parts[0] === 'health') {
        const cloud = credentials();
        if (!cloud.id) throw new HttpError(409, 'Connect a tunnel first.');
        const result = await cf(cfPath(cloud));
        return json(res, { status: result.status, connections: result.connections?.length ?? null });
      }
      if (req.method !== 'POST') throw new HttpError(404, 'Networking operation not found.');
      const input = await jsonBody(req);
      if (changing) throw new HttpError(409, 'A networking operation is already running.');
      changing = true;
      try {
        if (parts[0] === 'connect') await connect(input);
        else if (parts[0] === 'domain') await domain(input);
        else if (parts[0] === 'restart') {
          if (!credentials().id) throw new HttpError(409, 'Connect a tunnel first.');
          runNamed();
        } else if (parts[0] === 'quick') {
          const target = routeTarget(input.target);
          if (!target.startsWith('project:')) throw new HttpError(400, 'Quick Tunnels support applications only.');
          const previous = quick;
          quickUrl = null;
          let output = '';
          quickStatus = 'starting';
          const child = launch(['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', origin], {}, text => {
            if (quick !== child) return;
            output = (output + text).slice(-4096);
            quickUrl ||= output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
            if (text.includes('Registered tunnel connection')) quickStatus = 'connected';
            if (text.includes('ERR')) quickStatus = 'connection error';
          });
          child.target = target;
          quick = child;
          previous?.kill();
          child.on('close', () => { if (quick === child) { quick = null; quickUrl = null; quickStatus = 'connector exited'; } });
        } else if (parts[0] === 'quick-stop') {
          quick?.kill();
          quick = null;
          quickUrl = null;
          quickStatus = 'stopped';
        } else throw new HttpError(404, 'Networking operation not found.');
      } finally { changing = false; }
      return json(res, config());
    },
    async close() {
      closed = true;
      clearTimeout(reconnect);
      named?.kill();
      quick?.kill();
      if (server.listening) await new Promise(resolve => {
        server.close(resolve);
        server.closeAllConnections();
      });
    }
  };
}
