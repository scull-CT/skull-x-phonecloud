import { createServer } from 'node:http';
import { BlockList } from 'node:net';
import { networkInterfaces } from 'node:os';
import { HttpError } from '../core/store.mjs';
import { json } from '../core/http.mjs';

function localInterface() {
  const networks = Object.entries(networkInterfaces()).filter(([name]) =>
    process.platform !== 'android' || /^(wlan|wifi|eth)\d+$/i.test(name));
  for (const [, addresses] of networks) {
    const local = addresses.find(item => item.family === 'IPv4' && !item.internal &&
      /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(item.address) && item.cidr);
    if (local) return local;
  }
  return null;
}

export function lanGateway(store, projects, proxy, monitor, port, getInterface = localInterface) {
  let listener;
  let address;
  let cidr;
  let error = null;
  let pending = Promise.resolve();
  let closed = false;
  const target = () => store.get('lanProject');
  const config = () => ({ project: target(), url: listener ? `http://${address}:${listener.address().port}` : null, error });

  async function stop() {
    if (!listener) return;
    const server = listener;
    listener = null;
    await new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    });
  }

  function refresh() {
    pending = pending.then(async () => {
      const network = !closed && target() && getInterface();
      if (network && network.cidr === cidr && listener) return;
      await stop();
      error = null;
      if (!network) {
        if (!closed && target()) error = 'Connect the phone to Wi-Fi to get a local URL.';
        return;
      }
      const subnet = new BlockList();
      subnet.addSubnet(network.address, Number(network.cidr.split('/')[1]), 'ipv4');
      const server = createServer({ requestTimeout: 20000, headersTimeout: 10000 }, (req, res) => {
        const started = performance.now();
        res.on('finish', () => monitor.record(res.statusCode, performance.now() - started, true));
        res.setHeader('X-Content-Type-Options', 'nosniff');
        try {
          const expected = `${network.address}:${server.address()?.port}`;
          if (req.headers.host !== expected || !subnet.check(req.socket.remoteAddress || '')) {
            throw new HttpError(403, 'Use the PhoneCloud Wi-Fi address from this network.');
          }
          if (!req.url.startsWith('/') || req.url.startsWith('//') || req.url.startsWith('/\\')) throw new HttpError(400, 'Invalid request target.');
          const base = 'http://' + expected;
          const url = new URL(req.url, base);
          if (url.origin !== base) throw new HttpError(400, 'Invalid request target.');
          const id = target();
          if (!id) throw new HttpError(404, 'Wi-Fi sharing is off.');
          return proxy(id, req, res, url);
        } catch (cause) {
          if (res.headersSent) return res.destroy();
          return json(res, { error: cause instanceof HttpError ? cause.message : 'Application request failed.' }, cause instanceof HttpError ? cause.status : 500);
        }
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, network.address, resolve);
      });
      address = network.address;
      cidr = network.cidr;
      listener = server;
    }).catch(cause => {
      error = cause.code === 'EADDRINUSE' ? 'The Wi-Fi sharing port is already in use.' : 'Could not listen on the Wi-Fi address.';
    });
    return pending;
  }
  const timer = setInterval(refresh, 10000);
  timer.unref();
  return {
    config, refresh,
    async set(id) {
      if (id !== null && (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id))) throw new HttpError(400, 'Choose a project.');
      if (id !== null) projects.get(id);
      store.set('lanProject', id);
      store.audit(id ? 'Wi-Fi sharing enabled for project ' + id : 'Wi-Fi sharing disabled');
      await refresh();
      return config();
    },
    async close() {
      closed = true;
      clearInterval(timer);
      await refresh();
    }
  };
}
