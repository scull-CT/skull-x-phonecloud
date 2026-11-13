import { cloudViews, renderCloud, download } from './cloud.js';

const $ = id => document.getElementById(id);
const views = ['overview', 'monitoring', 'security', 'settings'];
const unavailable = 'Unavailable';
let session = {};
let requestNumber = 0;
let redraw = [];
const node = (type, value, className) => {
  const element = document.createElement(type);
  if (value != null) element.textContent = value;
  if (className) element.className = className;
  return element;
};

async function api(path, data, method = 'POST') {
  const response = await fetch('/api/' + path, data === undefined ? {} : {
    method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf || '' },
    body: JSON.stringify(data)
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && session.user) {
      session = {};
      await refreshSession();
    }
    throw new Error(result.error);
  }
  return result;
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('theme').textContent = theme === 'dark' ? 'Light mode' : 'Dark mode';
  localStorage.setItem('phonecloud-theme', theme);
  for (const draw of redraw) draw();
}
setTheme(localStorage.getItem('phonecloud-theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
$('theme').onclick = () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
addEventListener('resize', () => { for (const draw of redraw) draw(); });

function onSubmit(form, action) {
  form.addEventListener('submit', async event => {
    event.preventDefault();
    $('notice').textContent = '';
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    try {
      await action(Object.fromEntries(new FormData(form)));
      form.reset();
    } catch (error) { $('notice').textContent = error.message; }
    finally { button.disabled = false; }
  });
}
onSubmit($('access-form'), async input => {
  session = await api(session.setup ? 'setup' : 'login', input);
  await refreshView();
});
onSubmit($('password-form'), async input => {
  Object.assign(session, await api('password', input));
  $('notice').textContent = 'Password updated.';
});
$('logout').onclick = async () => {
  try { await api('logout', {}); await refreshSession(); }
  catch (error) { $('notice').textContent = error.message; }
};

async function refreshSession() {
  session = await api('session');
  await refreshView();
}
const view = () => {
  const section = location.hash.slice(1).split('/')[0];
  return [...views, ...cloudViews].includes(section) ? section : 'overview';
};
$('diagnostics').onclick = async () => {
  try { download('phonecloud-diagnostics.json', JSON.stringify(await api('diagnostics'), null, 2)); }
  catch (error) { $('notice').textContent = error.message; }
};
const fmt = (number, suffix = '') => Number.isFinite(number) ? number.toLocaleString(undefined, { maximumFractionDigits: 1 }) + suffix : unavailable;
function bytes(number) {
  if (!Number.isFinite(number)) return unavailable;
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const unit = Math.min(4, Math.floor(Math.log(Math.max(1, number)) / Math.log(1024)));
  return fmt(number / 1024 ** unit, ' ' + units[unit]);
}
const duration = value => !Number.isFinite(value) ? unavailable : value < 60 ? fmt(Math.floor(value), ' s') : fmt(Math.floor(value / 60), ' min');
const ratio = value => value?.total ? value.used / value.total * 100 : null;
function details(target, pairs) {
  $(target).replaceChildren(...pairs.map(([label, value]) => {
    const row = node('div');
    row.append(node('dt', label), node('dd', value ?? unavailable));
    return row;
  }));
}

function showOverview({ sample, pid, runtime, platform, architecture, projects, running, realtime, databaseCount }) {
  $('service-state').textContent = '● Online';
  $('overview-cards').replaceChildren(...[
    ['CPU utilization', fmt(sample.cpu, '%')],
    ['Memory used', fmt(ratio(sample.memory), '%')],
    ['Disk space available', bytes(sample.disk.available)],
    ['Service uptime', duration(sample.serviceUptime)], ['Running projects', running + ' / ' + projects],
    ['Databases', databaseCount], ['Realtime subscribers', realtime]
  ].map(([label, value]) => {
    const card = node('article', null, 'panel card');
    card.append(node('h2', label), node('strong', value));
    return card;
  }));
  details('service-details', [['Runtime', runtime], ['Host', platform + ' / ' + architecture],
    ['Manager process', pid], ['Manager memory', bytes(sample.processRss)], ['Device uptime', duration(sample.deviceUptime)]]);
}

function chart(label, rows, accessor, suffix) {
  const card = node('article', null, 'panel chart');
  const canvas = node('canvas');
  canvas.setAttribute('role', 'img');
  const points = rows.map(row => [row.time, accessor(row)]).filter(([, value]) => Number.isFinite(value));
  const current = points.at(-1)?.[1];
  const max = Math.max(1, ...points.map(([, value]) => value));
  const min = Math.min(...points.map(([, value]) => value));
  canvas.setAttribute('aria-label', points.length ? `${label} history, range ${fmt(min, suffix)} to ${fmt(Math.max(...points.map(([, value]) => value)), suffix)}` : `${label} has no readings`);
  card.append(node('h2', label), node('p', fmt(current, suffix)), canvas);
  function draw() {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    const dpr = Math.min(2, devicePixelRatio);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const styles = getComputedStyle(canvas);
    ctx.strokeStyle = styles.getPropertyValue('--edge');
    for (const y of [6, height / 2, height - 6]) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
    }
    if (!points.length) return;
    const begin = rows[0].time;
    const span = Math.max(1, rows.at(-1).time - begin);
    ctx.strokeStyle = ctx.fillStyle = styles.getPropertyValue('--accent');
    ctx.lineWidth = 2;
    ctx.beginPath();
    let previous = false;
    for (const row of rows) {
      const value = accessor(row);
      if (!Number.isFinite(value)) { previous = false; continue; }
      const x = 3 + (width - 6) * (row.time - begin) / span;
      const y = height - 6 - (height - 12) * value / max;
      if (previous) ctx.lineTo(x, y);
      else { ctx.fillRect(x - 2, y - 2, 4, 4); ctx.moveTo(x, y); }
      previous = true;
    }
    ctx.stroke();
  }
  redraw.push(draw);
  return card;
}

function showMonitoring({ sample, history }) {
  redraw = [];
  $('charts').replaceChildren(...[
    ['CPU usage', row => row.cpu, '%'], ['Memory usage', row => ratio(row.memory), '%'],
    ['Dashboard request rate', row => row.requests, '/s'], ['Dashboard response time', row => row.latency, ' ms'],
    ['Dashboard server errors', row => row.errors, '%'], ['Gateway request rate', row => row.gatewayRequests, '/s'],
    ['Gateway response time', row => row.gatewayLatency, ' ms'], ['Gateway server errors', row => row.gatewayErrors, '%'],
    ['Battery level', row => row.battery, '%']
  ].map(([label, accessor, suffix]) => chart(label, history, accessor, suffix)));
  for (const draw of redraw) draw();
  details('monitor-details', [['Network interfaces', sample.interfaceUp === null ? unavailable : sample.interfaceUp ? 'Active interface' : 'No active interface'],
    ['Download / upload', sample.network ? [sample.network.down, sample.network.up].map(value => bytes(value) + '/s').join(' / ') : unavailable],
    ['Battery charging status', sample.charging], ['Battery temperature', fmt(sample.batteryTemp, ' °C')],
    ['Thermal zone 0', fmt(sample.deviceTemp, ' °C')], ['Free storage', bytes(sample.disk.available)],
    ['Storage health', sample.disk.available < 256 * 1024 * 1024 ? 'Low free space' : 'Free space available']]);
}

async function refreshView() {
  const generation = ++requestNumber;
  const active = view();
  $('access').hidden = Boolean(session.user);
  $('sidebar').hidden = !session.user;
  for (const name of views) $(name).hidden = !session.user || name !== active;
  $('cloud').hidden = !session.user || !cloudViews.includes(active);
  if ($('cloud').hidden) renderCloud(null, null, null);
  if (!session.user) {
    $('access-title').textContent = session.setup ? 'Create your admin account' : 'Sign in';
    $('access-description').textContent = session.setup
      ? 'Enter the setup code displayed in Termux. Choose a password with at least 14 characters.' : 'Manage Skull X PhoneCloud on this device.';
    $('code-label').hidden = !session.setup;
    $('access-form').elements.code.required = Boolean(session.setup);
    $('access-form').elements.password.autocomplete = session.setup ? 'new-password' : 'current-password';
    $('access-submit').textContent = session.setup ? 'Create account' : 'Sign in';
    $('access-form').hidden = false;
    return;
  }
  for (const anchor of $('sidebar').querySelectorAll('nav a')) {
    if (anchor.hash === '#' + active) anchor.setAttribute('aria-current', 'page');
    else anchor.removeAttribute('aria-current');
  }
  if (active !== 'monitoring') redraw = [];
  if (cloudViews.includes(active)) return renderCloud(active, api, message => { $('notice').textContent = message; });
  if (active === 'settings') return;
  const endpoint = { overview: 'overview', monitoring: 'metrics?hours=' + $('range').value, security: 'audit' }[active];
  const result = await api(endpoint);
  if (generation !== requestNumber) return;
  if (active === 'overview') showOverview(result);
  if (active === 'monitoring') showMonitoring(result);
  if (active === 'security') $('audit').replaceChildren(...(result.length ? result.map(item => {
    const li = node('li', item.action);
    const time = node('time', new Date(item.time).toLocaleString());
    time.dateTime = new Date(item.time).toISOString();
    li.append(time);
    return li;
  }) : [node('li', 'No administrator activity yet.')]));
}
function refresh() { refreshView().catch(error => { $('notice').textContent = error.message; }); }
addEventListener('hashchange', () => { $('notice').textContent = ''; refresh(); $('main').focus(); });
$('range').onchange = refresh;
setInterval(() => { if (session.user && ['overview', 'monitoring'].includes(view()) && !document.hidden) refresh(); }, 30000);
refreshSession().catch(error => { $('access-title').textContent = 'Dashboard unavailable'; $('notice').textContent = error.message; });
