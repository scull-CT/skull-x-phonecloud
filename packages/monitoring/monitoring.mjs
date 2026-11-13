import os from 'node:os';
import { readFileSync, statfsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const read = path => {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
};
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const sum = values => values.reduce((a, b) => a + b, 0);
const percent = (used, total) => total > 0 ? Math.round(used * 100 / total) : null;

function cpuTimes() {
  const cpus = os.cpus();
  if (!cpus.length) return null;
  return { idle: sum(cpus.map(cpu => cpu.times.idle)), total: sum(cpus.map(cpu => sum(Object.values(cpu.times)))) };
}

function networkBytes() {
  const interfaces = read('/proc/net/dev').split('\n').slice(2).flatMap(line => {
    const [name, counters] = line.trim().split(':');
    if (!counters || name === 'lo') return [];
    const fields = counters.trim().split(/\s+/).map(Number);
    return fields.length === 16 ? [[fields[0], fields[8]]] : [];
  });
  if (!interfaces.length) return null;
  return { down: sum(interfaces.map(entry => entry[0])), up: sum(interfaces.map(entry => entry[1])) };
}

export function monitoring(store, interval = 30000) {
  let before = null;
  let latest;
  let battery = {};
  let batteryChecked = 0;
  let active = true;
  const counters = () => ({ count: 0, duration: 0, errors: 0 });
  let http = counters();
  let gateway = counters();
  const insert = store.db.prepare('INSERT OR REPLACE INTO metrics VALUES (?,?)');
  const prune = store.db.prepare('DELETE FROM metrics WHERE time < ?');
  function sample() {
    const time = Date.now();
    const cpu = cpuTimes();
    const network = networkBytes();
    const seconds = before && (time - before.time) / 1000;
    const disk = statfsSync(store.home);
    const total = os.totalmem();
    const elapsed = cpu && before?.cpu && cpu.total - before.cpu.total;
    const idle = elapsed && cpu.idle - before.cpu.idle;
    const interfaces = Object.values(os.networkInterfaces()).flat();
    const rawThermal = read('/sys/class/thermal/thermal_zone0/temp').trim();
    latest = {
      time,
      cpu: elapsed > 0 && idle >= 0 && idle <= elapsed ? percent(elapsed - idle, elapsed) : null,
      memory: total > 0 ? { used: total - os.freemem(), total } : null,
      disk: { used: (disk.blocks - disk.bfree) * disk.bsize, total: disk.blocks * disk.bsize, available: disk.bavail * disk.bsize },
      network: network && before?.network && seconds > 0 && network.up >= before.network.up && network.down >= before.network.down
        ? { down: (network.down - before.network.down) / seconds, up: (network.up - before.network.up) / seconds } : null,
      interfaceUp: interfaces.length ? interfaces.some(nic => !nic.internal) : null,
      battery: finite(battery.percentage), charging: battery.status ?? null, batteryTemp: finite(battery.temperature),
      deviceTemp: rawThermal && /^\d{4,6}$/.test(rawThermal) ? Number(rawThermal) / 1000 : null,
      deviceUptime: os.uptime() || null, serviceUptime: process.uptime(), processRss: process.memoryUsage().rss,
      requests: seconds > 0 ? http.count / seconds : null,
      latency: http.count ? http.duration / http.count : null,
      errors: http.count ? http.errors / http.count * 100 : null,
      gatewayRequests: seconds > 0 ? gateway.count / seconds : null,
      gatewayLatency: gateway.count ? gateway.duration / gateway.count : null,
      gatewayErrors: gateway.count ? gateway.errors / gateway.count * 100 : null
    };
    before = { time, cpu, network };
    http = counters();
    gateway = counters();
    insert.run(time, JSON.stringify(latest));
    prune.run(time - 7 * 86400000);
    if (process.env.PHONECLOUD_BATTERY === '1' && time - batteryChecked >= 120000) {
      batteryChecked = time;
      run('termux-battery-status', [], { timeout: 5000, maxBuffer: 8192 }).then(({ stdout }) => {
        if (active) battery = JSON.parse(stdout);
      }).catch(() => { battery = {}; });
    }
  }
  sample();
  const timer = setInterval(() => {
    try { sample(); } catch { console.error('Monitoring sample could not be saved.'); }
  }, interval);
  timer.unref();
  return {
    latest: () => latest,
    record(status, duration, publicTraffic = false) {
      const scope = publicTraffic ? gateway : http;
      scope.count++;
      scope.duration += duration;
      if (status >= 500) scope.errors++;
    },
    history(hours) {
      const rows = store.db.prepare('SELECT sample FROM metrics WHERE time >= ? ORDER BY time').all(Date.now() - hours * 3600000);
      const stride = Math.max(1, Math.ceil(rows.length / 360));
      return rows.filter((_, i) => i % stride === 0 || i === rows.length - 1).map(row => JSON.parse(row.sample));
    },
    close() { active = false; clearInterval(timer); }
  };
}
