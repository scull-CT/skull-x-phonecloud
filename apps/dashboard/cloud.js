import { databaseTree } from './database-tree.js';

export const cloudViews = ['projects', 'deployments', 'databases', 'realtime', 'storage', 'domains', 'networking', 'logs', 'backups'];
const names = Object.fromEntries(cloudViews.map(name => [name, name[0].toUpperCase() + name.slice(1)]));
const descriptions = {
  projects: 'Configure and run applications from GitHub or local files.',
  deployments: 'Check release history and roll back to a healthy build.',
  databases: 'Browse and edit live JSON data.',
  realtime: 'Watch committed changes arrive from a collection.',
  storage: 'Edit source files and manage persistent application data.',
  domains: 'Map public HTTPS hostnames to applications or databases.',
  networking: 'Manage the local gateway and Cloudflare connections.',
  logs: 'Inspect build output and application runtime logs.',
  backups: 'Create, verify and download encrypted snapshots.'
};
const selection = {};
const openBranches = new Map();
const databaseTabs = [['data', 'Data'], ['rules', 'Rules'], ['usage', 'Usage'], ['api', 'API'], ['domain', 'Custom domain']];
const databaseHref = (id, tab = 'data') => '#databases/' + id + '/' + tab;
let stream;
let generation = 0;
const pretty = value => JSON.stringify(value, null, 2);
const html = (tag, text, attributes = {}) => {
  const element = document.createElement(tag);
  if (text != null) element.textContent = text;
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
};
const panel = (...children) => { const box = html('div', null, { class: 'panel' }); box.append(...children); return box; };
const tools = (...children) => { const bar = html('div', null, { class: 'toolbar' }); bar.append(...children); return bar; };
const link = (text, href) => html('a', text, { href, target: '_blank', rel: 'noopener noreferrer' });
const show = value => html('pre', typeof value === 'string' ? value : pretty(value));
const note = text => html('p', text, { class: 'field-note' });
const field = (label, input) => {
  const element = html('label');
  const caption = html('span', label);
  input.setAttribute('aria-label', label);
  element.append(caption, input);
  return element;
};
function input(name, value = '', type = 'text') {
  return html('input', null, { name, value, type });
}
function area(name, value = '') { return html('textarea', value, { name, spellcheck: 'false' }); }
function select(name, options, value) {
  const control = html('select', null, { name });
  for (const [id, title] of options) control.append(html('option', title, { value: id }));
  if (options.some(([id]) => id === value)) control.value = value;
  return control;
}
const opts = items => items.map(item => [item, item]);
const rows = items => items.map(item => [item.id, item.name]);
const date = time => new Date(time).toLocaleString();
const data = form => Object.fromEntries(new FormData(form));
const json = (text, fallback) => text.trim() ? JSON.parse(text) : fallback;

export function download(name, contents, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const anchor = html('a', null, { href: url, download: name });
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function renderCloud(view, api, notice) {
  stream?.close();
  stream = null;
  const run = ++generation;
  if (!view) return;
  const target = document.getElementById('cloud');
  const heading = html('div', null, { class: 'page-head' });
  const title = html('div');
  title.append(html('h1', names[view]), html('p', descriptions[view]));
  heading.append(title);
  const content = html('div', null, { class: 'stack' });
  target.replaceChildren(heading, content);
  const reload = () => renderCloud(view, api, notice);
  async function perform(task, control) {
    notice('');
    if (control) control.disabled = true;
    try { await task(); }
    catch (error) { if (run === generation) notice(error.message); }
    finally { if (control) control.disabled = false; }
  }
  const button = (label, task) => {
    const control = html('button', label, { type: 'button' });
    control.onclick = () => perform(task, control);
    return control;
  };
  function form(label, fields, task) {
    const element = html('form');
    const submit = html('button', label, { type: 'submit', class: 'primary' });
    element.append(...fields, submit);
    element.onsubmit = event => { event.preventDefault(); void perform(() => task(data(element)), submit); };
    return element;
  }
  function choose(label, items, key) {
    const control = select(key, items, selection[key]);
    control.onchange = () => { selection[key] = control.value; void reload(); };
    selection[key] = control.value;
    return field(label, control);
  }
  function add(...elements) { if (generation === run) content.append(...elements); }
  try {
    if (['projects', 'deployments', 'logs', 'storage'].includes(view)) {
      const items = await api('projects');
      const selector = choose('Project', rows(items), 'project');
      const item = items.find(candidate => candidate.id === selection.project);
      if (view === 'projects') {
        const projectForm = (project, label) => form(label, [
          field('Name', input('name', project?.name)), field('Runtime', select('type', [['node', 'Node.js'], ['python', 'Python'], ['static', 'Static HTML'], ['vite', 'React / Vite']], project?.type)),
          field('GitHub repository URL', input('repo', project?.repo, 'url')), field('Branch', input('branch', project?.branch || 'main')),
          field('Static output directory', input('output', project?.output || '')), field('HTTP health path', input('health', project?.health || '/')),
          field('Restart backoff in seconds', input('backoff', project?.backoff || 2, 'number')),
          field('Install command as JSON array', area('install', project?.install?.length ? pretty(project.install) : '')),
          field('Build command as JSON array', area('build', project?.build?.length ? pretty(project.build) : '')),
          field('Start command as JSON array', area('start', project?.start?.length ? pretty(project.start) : '')),
          field('Replace environment secrets with JSON', area('secrets'))
        ], async values => {
          for (const name of ['install', 'build', 'start']) values[name] = json(values[name], []);
          values.secrets = json(values.secrets, undefined);
          const result = await api('projects' + (project ? '/' + project.id : ''), values, project ? 'PUT' : 'POST');
          selection.project = result.id;
          await reload();
        });
        const create = html('details');
        create.open = !item;
        create.append(html('summary', 'Create project'), note('Deploy only repositories and dependencies you trust. All apps share the Termux user.'), projectForm(null, 'Create project'));
        add(panel(create));
        if (!item) return;
        const base = 'projects/' + item.id;
        const state = item.busy ? 'Working' : item.running
          ? ['Running', item.healthStatus, item.pid ? 'PID ' + item.pid : 'static server', Math.floor(item.uptime) + ' s uptime'].join(' · ') : 'Stopped';
        const actions = ['deploy', 'start', 'stop', 'restart'].filter(action => !item.busy && (action === 'deploy' || item.current) && (action !== 'start' || !item.running))
          .map(action => button(action[0].toUpperCase() + action.slice(1), async () => {
            await api(base + '/action', { action });
            if (action === 'deploy') location.hash = '#deployments';
            else await reload();
          }));
        if (item.port) actions.push(link('Open application', 'http://localhost:' + item.port));
        else if (item.running) {
          const net = await api('networking');
          actions.push(link('Open application', net.origin.replace('127.0.0.1', 'localhost') + '/app/' + item.id + '/'));
        }
        const webhook = html('div');
        actions.push(button(item.webhookEnabled ? 'Rotate webhook secret' : 'Create webhook secret', async () => {
          const result = await api(base + '/webhook', {});
          webhook.replaceChildren(note('Save this secret now. Point a GitHub push webhook at /hooks/' + item.id + ' on a named public hostname.'), show(result.secret));
        }));
        if (item.webhookEnabled) actions.push(button('Disable webhook', async () => { await api(base + '/webhook', { disable: true }); await reload(); }));
        actions.push(button('Remove project', async () => {
          if (!confirm('Remove ' + item.name + ' from active projects? Its files will remain on disk.')) return;
          await api(base, {}, 'DELETE'); await reload();
        }));
        const edit = html('details');
        edit.append(html('summary', 'Edit project'), note('Stored environment variable names: ' + (item.secretNames.join(', ') || 'none')), projectForm(item, 'Save configuration'));
        add(panel(selector, html('h2', item.name), note(state), tools(...actions), webhook), panel(edit));
        return;
      }
      if (!item) return add(panel(note('Create a project to use this view.'), tools(link('Go to Projects', '#projects'))));
      const base = 'projects/' + item.id;
      if (view === 'deployments') {
        const releases = await api(base + '/releases');
        add(panel(selector, tools(button('Refresh releases', reload))));
        if (!releases.length) add(panel(note('Deploy this project to create its first release.')));
        for (const release of releases) {
          const current = release.id === item.current;
          const section = panel(html('h2', (current ? 'Active · ' : '') + release.status), note(date(release.time) + (release.commit ? ' · ' + release.commit.slice(0, 12) : '')));
          if (release.error) section.append(note(release.error));
          if (!current && release.status === 'ready' && !item.busy) section.append(tools(button('Roll back to this release', async () => {
            await api(base + '/action', { action: 'rollback', release: release.id }); await reload();
          })));
          add(section);
        }
      }
      if (view === 'logs') {
        const kind = choose('Log stream', opts(['runtime', 'build']), 'logKind');
        const result = await api(base + '/logs?kind=' + selection.logKind);
        add(panel(selector, kind, tools(button('Refresh logs', reload)), result.log ? show(result.log) : note('No log output yet.')));
      }
      if (view === 'storage') {
        const fileArea = choose('Storage area', opts(['source', 'data']), 'fileArea');
        const path = selection.file || '';
        const files = await api(base + '/files', { area: selection.fileArea });
        const editor = area('content');
        const pathField = input('path', path);
        const upload = input('upload', '', 'file');
        const request = (action, path, values = {}) => api(base + '/files', { area: selection.fileArea, action, path, ...values });
        const save = form('Save text file', [field('Relative file path', pathField), field('Text content', editor)], async values => {
          await request('write', values.path, { content: values.content }); selection.file = values.path; await reload();
        });
        const listing = tools(...files.map(name => button(name, async () => {
          const file = await request('read', name);
          selection.file = pathField.value = name;
          editor.value = file.content;
        })));
        const fileActions = tools(
          button('Upload selected file', async () => {
            const file = upload.files[0];
            if (!file || file.size > 2 * 1024 * 1024) throw new Error('Choose a file of at most 2 MiB.');
            const bytes = new Uint8Array(await file.arrayBuffer());
            await request('write', pathField.value || file.name, { content: bytes.toBase64(), encoding: 'base64' });
            await reload();
          }),
          button('Download file', async () => {
            const file = await request('read', pathField.value, { encoding: 'base64' });
            download(pathField.value.split('/').at(-1), Uint8Array.fromBase64(file.content), 'application/octet-stream');
          }),
          button('Delete file', async () => {
            if (!pathField.value || !confirm('Delete this file?')) return;
            await request('delete', pathField.value); selection.file = ''; await reload();
          })
        );
        add(panel(selector, fileArea, files.length ? listing : note('No files in this area.')),
          panel(save, field('Upload a file', upload), fileActions));
      }
      return;
    }
    if (view === 'databases') {
      const items = await api('databases');
      if (run !== generation) return;
      const [, id, requestedTab] = location.hash.slice(1).split('/');
      const item = items.find(candidate => candidate.id === id);
      if (!item) {
        const create = html('details', null, { class: 'database-create' });
        create.append(html('summary', 'New database'), form('Create database', [
          field('Database name', input('name')), field('Optional HTTPS CORS origin', input('origin', '', 'url'))
        ], async values => { location.hash = databaseHref((await api('databases', values)).id); }));
        add(panel(create));
        if (!items.length) return add(panel(note('No databases yet. Create one to start storing live JSON data.')));
        const listing = html('ul', null, { class: 'database-list' });
        for (const item of items) {
          const row = html('li');
          const open = html('a', null, { href: databaseHref(item.id) });
          open.append(html('strong', item.name), html('span', '›', { 'aria-hidden': 'true' }));
          row.append(open);
          listing.append(row);
        }
        return add(panel(listing));
      }
      const base = 'databases/' + item.id;
      const database = await api(base);
      if (run !== generation) return;
      const tab = databaseTabs.some(([key]) => key === requestedTab) ? requestedTab : 'data';
      title.replaceChildren(html('a', '← All databases', { href: '#databases', class: 'database-back' }), html('h1', item.name));
      const tabs = html('nav', null, { class: 'database-tabs', 'aria-label': 'Database sections' });
      for (const [key, label] of databaseTabs) {
        const anchor = html('a', label, { href: databaseHref(item.id, key) });
        if (tab === key) anchor.setAttribute('aria-current', 'page');
        tabs.append(anchor);
      }
      add(tabs);
      if (tab === 'usage') {
        const usagePanel = panel(html('h2', 'Usage'));
        const output = html('div');
        async function loadUsage() {
          const usage = await api(base + '/usage');
          if (run !== generation) return;
          const cards = html('div', null, { class: 'database-stats' });
          for (const [label, value] of [['Storage (bytes)', usage.size], ['Collections', usage.collections],
            ['Documents', usage.documents], ['Live connections', usage.active], ['API keys', usage.keys], ['Database users', usage.users]]) {
            const card = html('div');
            card.append(html('strong', value.toLocaleString()), note(label));
            cards.append(card);
          }
          const table = html('table', null, { class: 'database-usage' });
          table.append(html('caption', 'Client API requests · last 7 days (UTC)'));
          const head = html('thead');
          const columns = html('tr');
          for (const label of ['Date', 'Requests', 'Rejected', 'Writes']) columns.append(html('th', label, { scope: 'col' }));
          head.append(columns);
          const body = html('tbody');
          const byDay = new Map(usage.daily.map(day => [day.day, day]));
          for (let days = 6; days >= 0; days--) {
            const date = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
            const day = byDay.get(date);
            const line = html('tr');
            for (const value of [date, day?.requests ?? 0, day?.rejected ?? 0, day?.writes ?? 0]) line.append(html('td', value));
            body.append(line);
          }
          table.append(head, body);
          output.replaceChildren(cards, table);
        }
        usagePanel.append(tools(button('Refresh usage', loadUsage)), output);
        add(usagePanel);
        await loadUsage();
        return;
      }
      if (tab === 'rules') {
        const result = note('');
        result.setAttribute('role', 'status');
        add(panel(html('h2', 'Database rules'),
          note('false requires a database API key. "auth" allows signed-in database users where the collection permits it. true allows reads from public collections.'),
          form('Publish rules', [field('Rules JSON', area('rules', pretty({ rules: database.rules })))], async values => {
            await api(base + '/rules', JSON.parse(values.rules), 'PUT');
            result.textContent = 'Rules published.';
          }), result));
        if (database.collections.length) {
          const collectionSelect = select('collection', opts(database.collections.map(item => item.name)));
          const read = select('read', opts(['private', 'user', 'public']));
          const write = select('write', opts(['private', 'user']));
          function applyPermissions() {
            const current = database.collections.find(item => item.name === collectionSelect.value);
            read.value = current.read;
            write.value = current.write;
          }
          collectionSelect.onchange = applyPermissions;
          applyPermissions();
          add(panel(html('h2', 'Collection permissions'), form('Save permissions', [
            field('Collection', collectionSelect), field('Read permission', read), field('Write permission', write)
          ], async values => {
            await api(base + '/collections/' + values.collection, { read: values.read, write: values.write }, 'PUT');
            Object.assign(database.collections.find(item => item.name === values.collection), { read: values.read, write: values.write });
            notice('Collection permissions saved.');
          })));
        }
        return;
      }
      if (tab === 'api' || tab === 'domain') {
        const net = await api('networking');
        if (run !== generation) return;
        const target = 'database:' + item.id;
        const domains = Object.entries(net.domains).filter(([, info]) => info.target === target);
        if (tab === 'domain') {
          if (!net.id) return add(panel(html('h2', 'Custom domain'), note('Connect a named Cloudflare tunnel to give this database an HTTPS address.'),
            tools(html('a', 'Open Networking', { href: '#networking' }))));
          add(panel(html('h2', 'Add hostname'), form('Connect domain', [
            field('Hostname', input('hostname')), field('Create Cloudflare DNS record', input('dns', 'yes', 'checkbox'))
          ], async values => { await api(base + '/domain', values); await reload(); }),
          note('Manual DNS target: ' + net.id + '.cfargotunnel.com')));
          for (const [hostname] of domains) {
            const output = html('div');
            add(panel(html('h2', hostname), tools(
              button('Test DNS and HTTPS', async () => output.replaceChildren(show(await api('networking/verify?host=' + encodeURIComponent(hostname))))),
              button('Remove domain', async () => {
                if (confirm('Remove ' + hostname + '?')) { await api(base + '/domain', { hostname, remove: true }); await reload(); }
              })), output));
          }
          return;
        }
        const local = net.origin + '/db/' + item.id;
        const endpoint = domains.length ? 'https://' + domains[0][0] : local;
        const branchSelect = select('branch', opts(database.collections.map(branch => branch.name)));
        const examples = html('div');
        function showExamples() {
          const branch = branchSelect.value || 'collection';
          examples.replaceChildren(
            note('Read documents with a database key'), show('curl -H "Authorization: Bearer YOUR_KEY" "' + endpoint + '/records/' + branch + '"'),
            note('Write a document with a write key'), show('curl -X POST -H "Authorization: Bearer YOUR_WRITE_KEY" -H "Content-Type: application/json" -d \'{"message":"Hello"}\' "' + endpoint + '/records/' + branch + '"'),
            note('Listen for committed changes'), show('curl -N -H "Authorization: Bearer YOUR_KEY" "' + endpoint + '/events/' + branch + '"'));
        }
        branchSelect.onchange = showExamples;
        showExamples();
        add(panel(html('h2', 'Database API'), note('Local endpoint'), show(local),
          ...domains.map(([hostname]) => show('https://' + hostname)),
          note('The local address is for apps running on the phone. Use a custom HTTPS domain for other devices.'),
          ...(database.collections.length ? [field('Branch for API examples', branchSelect)] : []), examples));
        const credentials = panel(html('h2', 'API keys and users'));
        const issued = html('div');
        credentials.append(note('Read keys can read private collections. Write keys can also create, edit and delete documents. Keep write keys on trusted servers.'),
        form('Create key', [field('Key label', input('label')), field('Permission', select('permission', opts(['read', 'write'])))], async values => {
          const result = await api(base + '/keys', values);
          issued.replaceChildren(note('Save this key now. It is displayed once.'), show(result.key), tools(button('Refresh credentials', reload)));
        }), issued,
        tools(...database.keys.map(key => button('Revoke ' + key.label, async () => { await api(base + '/keys', { label: key.label }, 'DELETE'); await reload(); }))),
        form('Create database user', [field('Username', input('name')), field('Password', input('password', '', 'password'))], async values => { await api(base + '/users', values); await reload(); }),
        tools(...database.users.map(name => button('Remove ' + name, async () => { await api(base + '/users', { name }, 'DELETE'); await reload(); }))));
        add(credentials);
        return;
      }
      const definition = html('details', null, { class: 'database-create' });
      if (!openBranches.has(id)) openBranches.set(id, new Set());
      const expanded = openBranches.get(id);
      definition.append(html('summary', 'Add root branch'), form('Create branch', [
        field('Branch name', input('name')), field('Optional field rules (JSON)', area('fields', '{}'))
      ], async values => {
        values.fields = json(values.fields, {}); await api(base + '/collections', values);
        expanded.add(values.name); await reload();
      }));
      const root = panel(html('h2', 'Data'), html('code', '/', { class: 'database-root' }), definition);
      const treeList = html('div', null, { class: 'database-branches' });
      const trees = new Map();
      stream = { close() { for (const tree of trees.values()) tree.close(); } };
      root.append(treeList);
      for (const { name } of database.collections) {
        const branch = html('details', null, { class: 'database-branch' });
        branch.append(html('summary', name));
        branch.ontoggle = () => {
          if (run !== generation) return;
          if (branch.open) {
            if (trees.has(name)) return;
            const tree = databaseTree({ api, base, collection: name, notice });
            trees.set(name, tree);
            expanded.add(name);
            branch.append(tree.panel, exchangeControls(base, name));
          } else if (trees.has(name)) {
            trees.get(name).close();
            trees.delete(name);
            expanded.delete(name);
            branch.replaceChildren(branch.firstElementChild);
          }
        };
        treeList.append(branch);
        branch.open = expanded.has(name);
      }
      if (!database.collections.length) treeList.append(note('The root is empty. Add a branch to store documents.'));
      add(root);
      return;
    }
    function exchangeControls(base, collection) {
      const exchange = base + '/exchange/' + collection;
      const exchangePanel = html('details');
      exchangePanel.append(html('summary', 'Import and export'), form('Import documents', [
        field('Format', select('format', opts(['JSON', 'CSV']))), field('Paste an array or CSV with a header', area('records'))
      ], async values => { await api(exchange, { rows: values.format === 'CSV' ? fromCsv(values.records) : JSON.parse(values.records) }); await reload(); }),
      tools(button('Export JSON', async () => download(collection + '.json', pretty(await api(exchange)))),
        button('Export CSV', async () => download(collection + '.csv', toCsv(await api(exchange)), 'text/csv'))));
      return exchangePanel;
    }
    if (view === 'realtime') {
      const items = await api('databases');
      const selector = choose('Database', rows(items), 'database');
      const item = items.find(candidate => candidate.id === selection.database);
      if (!item) return add(panel(note('Create a database to subscribe to changes.')));
      const base = 'databases/' + item.id;
      const database = await api(base);
      const collectionSelect = choose('Collection', opts(database.collections.map(collection => collection.name)), 'collection');
      const collection = selection.collection;
      add(panel(selector, collectionSelect));
      if (!collection) return add(panel(note('Add a branch to subscribe.')));
      const output = show('Waiting for changes…');
      const status = note('Connecting…');
      if (run !== generation) return;
      stream = new EventSource('/api/' + base + '/events/' + collection);
      stream.onopen = () => { status.textContent = 'Connected'; };
      stream.onerror = () => { status.textContent = 'Reconnecting…'; };
      const events = [];
      stream.addEventListener('change', event => {
        events.unshift(date(Date.now()) + '\n' + pretty(JSON.parse(event.data)));
        if (events.length > 25) events.pop();
        output.textContent = events.join('\n\n');
      });
      add(panel(status, output));
      return;
    }
    if (view === 'networking' || view === 'domains') {
      const net = await api('networking');
      const projects = await api('projects');
      const databases = view === 'domains' ? await api('databases') : [];
      if (view === 'networking') {
        add(panel(html('h2', 'Local gateway'), note(net.origin), note('Install cloudflared in Termux to use tunnels. The dashboard stays on its separate loopback port.')));
        const shared = projects.find(project => project.id === net.lan.project);
        add(panel(html('h2', 'Same Wi-Fi'),
          note('Share one application with devices on this local network. Anyone on the network can open it over HTTP.'),
          ...(net.lan.url && shared ? [tools(link('Open ' + shared.name, net.lan.url)), note('Share this URL: ' + net.lan.url)] : []),
          ...(net.lan.error ? [note(net.lan.error)] : []),
          ...(projects.length ? [form('Share on Wi-Fi', [field('Application', select('project', rows(projects), net.lan.project))],
            async values => { await api('networking/lan', values); await reload(); })] : [note('Create and deploy an application to share it.')]),
          tools(button('Refresh Wi-Fi status', reload), ...(net.lan.project ? [button('Stop Wi-Fi sharing', async () => {
            await api('networking/lan', { project: null }); await reload();
          })] : []))));
        const controls = html('div');
        add(panel(html('h2', 'Named tunnel'), net.id ? note(net.id + (net.namedRunning ? ' · connector running' : ' · connector stopped')) :
          form('Connect Cloudflare', [field('Account ID', input('account')), field('Scoped API token', input('apiToken', '', 'password')),
            field('Existing tunnel ID or blank to create', input('id')), field('DNS zone ID (optional)', input('zone'))],
          async values => { await api('networking/connect', values); await reload(); }),
        ...(net.id ? [tools(button('Check tunnel health', async () => controls.replaceChildren(show(await api('networking/health')))),
          button('Restart connector', async () => { await api('networking/restart', {}); await reload(); })), controls] : [])));
        add(panel(html('h2', 'Temporary public URL'), note('Connector ' + net.quickStatus), net.quickUrl ? tools(link(net.quickUrl, net.quickUrl)) : note(net.quickRunning ? 'Waiting for Cloudflare to assign a URL.' : 'Start a free temporary tunnel for an application.'),
          ...(projects.length ? [form('Start temporary tunnel', [field('Application', select('target', projects.map(item => ['project:' + item.id, item.name])))],
            async values => { await api('networking/quick', values); await reload(); })] : []),
          tools(button('Refresh status', reload), ...(net.quickRunning ? [button('Stop temporary tunnel', async () => { await api('networking/quick-stop', {}); await reload(); })] : []))));
      } else {
        if (!net.id) return add(panel(note('Connect a named tunnel from Networking to manage hostnames.')));
        const options = [...projects.map(item => ['project:' + item.id, 'App · ' + item.name]), ...databases.map(item => ['database:' + item.id, 'Database · ' + item.name])];
        if (options.length) add(panel(form('Save hostname', [field('Hostname', input('hostname')), field('Route to', select('target', options)),
          field('Create Cloudflare DNS record', input('dns', 'yes', 'checkbox'))], async values => { await api('networking/domain', values); await reload(); }),
        note('Manual DNS target: ' + net.id + '.cfargotunnel.com')));
        for (const [hostname, info] of Object.entries(net.domains)) {
          const output = html('div');
          add(panel(html('h2', hostname), note(options.find(([id]) => id === info.target)?.[1] || 'Target removed'),
            tools(button('Test DNS and HTTPS', async () => output.replaceChildren(show(await api('networking/verify?host=' + encodeURIComponent(hostname))))),
              button('Remove hostname', async () => { if (confirm('Remove ' + hostname + '?')) { await api('networking/domain', { hostname, remove: true }); await reload(); } })),
            output));
        }
      }
      return;
    }
    if (view === 'backups') {
      const backups = await api('backups');
      add(panel(html('h2', 'Manual backup'), form('Create encrypted backup', [field('Passphrase (at least 16 characters)', input('password', '', 'password'))],
        async values => { await api('backups/create', values); await reload(); })),
      panel(html('h2', 'Scheduled backups'), note(backups.schedule ? 'Next backup ' + date(backups.schedule.next) : 'No schedule configured.'),
        form('Save schedule', [field('Interval in hours', input('hours', backups.schedule?.hours ?? 24, 'number')),
          field('Number to retain', input('retention', backups.schedule?.retention ?? 5, 'number')), field('Passphrase', input('password', '', 'password'))],
        async values => { await api('backups/schedule', { ...values, hours: Number(values.hours), retention: Number(values.retention) }); await reload(); }),
        ...(backups.schedule ? [tools(button('Disable schedule', async () => { await api('backups/schedule', { disable: true }); await reload(); }))] : [])));
      for (const file of backups.files) {
        const path = 'backups/' + file.name;
        const result = html('div');
        add(panel(html('h2', file.name), note(file.bytes.toLocaleString() + ' bytes'),
          tools(html('a', 'Download encrypted file', { href: '/api/' + path, download: file.name })),
          form('Verify passphrase and archive', [field('Passphrase', input('password', '', 'password'))], async values => result.replaceChildren(show(await api(path + '/verify', values)))),
          result));
      }
      add(panel(note('Preview or restore from Termux with phonecloud restore FILE --preview or --apply.')));
    }
  } catch (error) { if (run === generation) notice(error.message); }
}

function toCsv(rows) {
  const keys = [...new Set(rows.flatMap(Object.keys))];
  const quote = value => '"' + String(value).replaceAll('"', '""') + '"';
  return [keys.map(quote).join(','), ...rows.map(row => keys.map(key => quote(Object.hasOwn(row, key) ? JSON.stringify(row[key]) : '')).join(','))].join('\r\n');
}

function fromCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i <= text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') quoted = false;
      else if (char === undefined) throw new Error('Unclosed CSV quote.');
      else cell += char;
    } else if (char === '"' && !cell) quoted = true;
    else if (char === ',' || char === '\n' || char === '\r' || char === undefined) {
      row.push(cell);
      cell = '';
      if (char !== ',') {
        if (char === '\r' && text[i + 1] === '\n') i++;
        if (row.length > 1 || row[0]) rows.push(row);
        row = [];
      }
    } else cell += char;
  }
  const keys = rows.shift();
  if (!keys || new Set(keys).size !== keys.length) throw new Error('CSV needs a unique header.');
  return rows.map(row => {
    if (row.length !== keys.length) throw new Error('CSV row length differs from its header.');
    return Object.fromEntries(row.flatMap((value, i) => {
      if (value === '') return [];
      try { return [[keys[i], JSON.parse(value)]]; }
      catch { return [[keys[i], value]]; }
    }));
  });
}
