export const cloudViews = ['projects', 'deployments', 'databases', 'realtime', 'storage', 'domains', 'networking', 'logs', 'backups'];
const names = Object.fromEntries(cloudViews.map(name => [name, name[0].toUpperCase() + name.slice(1)]));
const descriptions = {
  projects: 'Configure and run applications from GitHub or local files.',
  deployments: 'Check release history and roll back to a healthy build.',
  databases: 'Manage collections, documents and database credentials.',
  realtime: 'Watch committed changes arrive from a collection.',
  storage: 'Edit source files and manage persistent application data.',
  domains: 'Map public HTTPS hostnames to applications or databases.',
  networking: 'Manage the local gateway and Cloudflare connections.',
  logs: 'Inspect build output and application runtime logs.',
  backups: 'Create, verify and download encrypted snapshots.'
};
const selection = {};
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
    if (['databases', 'realtime'].includes(view)) {
      const items = await api('databases');
      const selector = choose('Database', rows(items), 'database');
      const item = items.find(candidate => candidate.id === selection.database);
      if (view === 'databases') {
        const create = html('details');
        create.open = !item;
        create.append(html('summary', 'Create database'), form('Create database', [field('Name', input('name')), field('Optional HTTPS CORS origin', input('origin', '', 'url'))], async values => {
          selection.database = (await api('databases', values)).id; await reload();
        }));
        add(panel(create));
      }
      if (!item) return add(panel(note('Create a database to add collections and subscribe to changes.')));
      const base = 'databases/' + item.id;
      const database = await api(base);
      const collectionSelect = choose('Collection', database.collections.map(collection => [collection.name, collection.name]), 'collection');
      const collection = selection.collection;
      add(panel(selector, collectionSelect, note(database.size.toLocaleString() + ' bytes · ' + database.subscribers + ' connected subscribers')));
      if (view === 'realtime') {
        if (!collection) return add(panel(note('Add a collection to subscribe.')));
        const output = show('Waiting for changes…');
        const status = note('Connecting…');
        const url = '/api/' + base + '/events/' + collection;
        if (run !== generation) return;
        stream = new EventSource(url);
        stream.onopen = () => { status.textContent = 'Connected'; };
        stream.onerror = () => { status.textContent = 'Reconnecting…'; };
        const events = [];
        stream.addEventListener('change', event => {
          events.unshift(date(Date.now()) + '\n' + pretty(JSON.parse(event.data)));
          output.textContent = events.slice(0, 25).join('\n\n');
        });
        add(panel(status, output));
        return;
      }
      const definition = html('details');
      definition.append(html('summary', 'Add collection'), form('Create collection', [
        field('Collection name', input('name')), field('Read permission', select('read', opts(['private', 'user', 'public']))),
        field('Write permission', select('write', opts(['private', 'user']))),
        field('Fields as JSON', area('fields', '{"title":{"type":"string","required":true,"unique":true}}'))
      ], async values => {
        values.fields = json(values.fields, {}); await api(base + '/collections', values);
        selection.collection = values.name; await reload();
      }));
      const credentials = html('details');
      const issued = html('div');
      credentials.append(html('summary', 'Database keys and users'),
        note('A read or write key can access private collections. Keep write keys on trusted servers.'),
        form('Create key', [field('Key label', input('label')), field('Permission', select('permission', opts(['read', 'write'])))], async values => {
          const result = await api(base + '/keys', values);
          issued.replaceChildren(note('Save this key now. It is displayed once.'), show(result.key), tools(button('Refresh credentials', reload)));
        }), issued,
        tools(...database.keys.map(key => button('Revoke ' + key.label, async () => { await api(base + '/keys', { label: key.label }, 'DELETE'); await reload(); }))),
        form('Create database user', [field('Username', input('name')), field('Password', input('password', '', 'password'))], async values => { await api(base + '/users', values); await reload(); }),
        tools(...database.users.map(name => button('Remove ' + name, async () => { await api(base + '/users', { name }, 'DELETE'); await reload(); }))));
      add(panel(definition), panel(credentials));
      if (!collection) return;
      const records = base + '/records/' + collection;
      const offset = Number(selection.offset || 0);
      const list = await api(records + '?limit=25&offset=' + offset);
      const editor = area('record', '{}');
      const recordId = input('id', '', 'hidden');
      add(panel(html('h2', 'Record editor'), form('Save record', [recordId, field('Document JSON', editor)], async values => {
        await api(records + (values.id ? '/' + values.id : ''), JSON.parse(values.record), values.id ? 'PUT' : 'POST'); await reload();
      }), tools(button('New record', () => { recordId.value = ''; editor.value = '{}'; editor.focus(); })),
      tools(button('Previous page', () => { selection.offset = Math.max(0, offset - 25); return reload(); }),
        ...(list.length === 25 ? [button('Next page', () => { selection.offset = offset + 25; return reload(); })] : []))));
      for (const row of list) add(panel(show(row.data), tools(
        button('Edit record', () => { recordId.value = row.id; editor.value = pretty(row.data); editor.focus(); }),
        button('Delete record', async () => { if (confirm('Delete this document?')) { await api(records + '/' + row.id, {}, 'DELETE'); await reload(); } })
      )));
      const exchange = base + '/exchange/' + collection;
      const exchangePanel = html('details');
      exchangePanel.append(html('summary', 'Import and export'), form('Import documents', [
        field('Format', select('format', opts(['JSON', 'CSV']))), field('Paste an array or CSV with a header', area('records'))
      ], async values => { await api(exchange, { rows: values.format === 'CSV' ? fromCsv(values.records) : JSON.parse(values.records) }); await reload(); }),
      tools(button('Export JSON', async () => download(collection + '.json', pretty(await api(exchange)))),
        button('Export CSV', async () => download(collection + '.csv', toCsv(await api(exchange)), 'text/csv'))));
      add(panel(exchangePanel));
      return;
    }
    if (view === 'networking' || view === 'domains') {
      const net = await api('networking');
      const projects = await api('projects');
      const databases = view === 'domains' ? await api('databases') : [];
      if (view === 'networking') {
        add(panel(html('h2', 'Local gateway'), note(net.origin), note('Install cloudflared in Termux to use tunnels. The dashboard stays on its separate loopback port.')));
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
