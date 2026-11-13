const pageSize = 25;
const pretty = value => JSON.stringify(value, null, 2);
const typeOf = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
const branch = value => ['object', 'array'].includes(typeOf(value));
const pointer = path => '/' + path.map(key => key.replaceAll('~', '~0').replaceAll('/', '~1')).join('/');

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(label, click) {
  const control = element('button', label);
  control.type = 'button';
  control.onclick = click;
  return control;
}

function field(label, control) {
  const node = element('label', label);
  node.append(control);
  return node;
}

function preview(value) {
  if (Array.isArray(value)) return '[' + value.length + ' items]';
  if (branch(value)) return '{' + Object.keys(value).length + ' keys}';
  const text = JSON.stringify(value);
  return text.length > 110 ? text.slice(0, 107) + '…' : text;
}

export function databaseTree({ api, base, collection, notice }) {
  const panel = element('section', undefined, 'panel database-tree');
  const header = element('div', undefined, 'tree-header');
  const title = element('div');
  title.append(element('h3', collection));
  const status = element('span', 'Connecting…', 'tree-status');
  status.setAttribute('role', 'status');
  header.append(title, status);
  const toolbar = element('div', undefined, 'toolbar');
  const list = element('ul', undefined, 'tree-list');
  list.setAttribute('aria-label', 'JSON data tree');
  const paging = element('div', undefined, 'tree-header tree-paging');
  const pageText = element('span', '');
  const editor = element('form', undefined, 'tree-editor');
  editor.hidden = true;
  const editorTitle = element('h3', '');
  const editorPath = element('code', '');
  const key = element('input');
  key.autocomplete = 'off';
  key.setAttribute('aria-label', 'Child key');
  const keyField = field('Child key', key);
  const value = element('textarea');
  value.spellcheck = false;
  value.setAttribute('aria-label', 'JSON value');
  const valueField = field('JSON value', value);
  const warning = element('p', '', 'tree-warning');
  warning.setAttribute('role', 'status');
  const save = element('button', 'Save', 'primary');
  save.type = 'submit';
  const editorButtons = element('div', undefined, 'toolbar');
  const cancel = button('Cancel', () => closeEditor());
  editorButtons.append(save, cancel);
  editor.append(editorTitle, editorPath, keyField, valueField, warning, editorButtons);
  panel.append(header, toolbar, editor, list, paging);

  const records = base + '/records/' + collection;
  const expanded = new Set();
  const more = new Map();
  let rows = [];
  let offset = 0;
  let editing;
  let previousFocus;
  let disposed = false;
  let timer;
  let refreshing = false;
  let refreshAgain = false;
  let loaded = false;

  function closeEditor(restoreFocus = true) {
    editing = undefined;
    editor.hidden = true;
    if (restoreFocus) (previousFocus?.isConnected ? previousFocus : addDocument).focus();
  }

  function edit(action, record, path, current) {
    if (save.disabled) return;
    previousFocus = document.activeElement;
    editing = { action, record, path, current };
    warning.textContent = '';
    editorTitle.textContent = { create: 'Add document', add: 'Add child', set: 'Edit value', remove: 'Delete value' }[action];
    editorPath.textContent = pointer([collection, ...(record ? [record.id] : []), ...path]);
    keyField.hidden = action !== 'add' || Array.isArray(current);
    key.value = '';
    valueField.hidden = action === 'remove';
    value.value = action === 'create' ? '{}' : action === 'set' ? pretty(current) : 'null';
    if (action === 'remove') warning.textContent = path.length ? 'Delete this value and any children?' : 'Delete this entire document?';
    save.textContent = action === 'remove' ? 'Delete' : 'Save';
    editor.hidden = false;
    (action === 'remove' ? cancel : keyField.hidden ? value : key).focus();
  }

  editor.onsubmit = async event => {
    event.preventDefault();
    if (!editing || save.disabled) return;
    save.disabled = cancel.disabled = true;
    const { action, record, path, current } = editing;
    try {
      const next = action === 'remove' ? undefined : JSON.parse(value.value);
      if (action === 'create') {
        await api(records, next);
        offset = 0;
      } else if (action === 'remove' && !path.length) {
        await api(records + '/' + record.id + '?updated=' + record.updated, {}, 'DELETE');
      } else {
        if (action === 'add' && !Array.isArray(current) && !key.value.length) throw new Error('Enter a child key.');
        const target = action === 'add' ? [...path, Array.isArray(current) ? '-' : key.value] : path;
        await api(records + '/' + record.id, { action, path: target, value: next, expected: current, updated: record.updated }, 'PATCH');
      }
      if (disposed) return;
      closeEditor();
      await refresh();
    } catch (error) {
      if (!disposed) warning.textContent = error.message;
    } finally {
      save.disabled = cancel.disabled = false;
    }
  };

  function item(record, path, name, current) {
    const id = pointer([record.id, ...path]);
    const node = element('li');
    const row = element('div', undefined, 'tree-row');
    const label = element('code', name || '""', 'tree-key');
    const sample = element('code', preview(current), 'tree-value tree-' + typeOf(current));
    const children = element('ul', undefined, 'tree-children');
    children.hidden = true;
    function renderChildren() {
      const keys = Object.keys(current);
      const limit = more.get(id) || 30;
      children.replaceChildren(...keys.slice(0, limit).map(key => item(record, [...path, key], key, current[key])));
      if (keys.length > limit) {
        const next = element('li');
        next.append(button('Show more children', () => {
          more.set(id, limit + 30);
          renderChildren();
          children.children[limit]?.querySelector('button')?.focus();
        }));
        children.append(next);
      }
    }
    if (branch(current)) {
      const toggle = button(expanded.has(id) ? '▾' : '▸', () => {
        if (expanded.delete(id)) {
          children.hidden = true;
          children.replaceChildren();
        } else {
          expanded.add(id);
          children.hidden = false;
          renderChildren();
        }
        toggle.textContent = children.hidden ? '▸' : '▾';
        toggle.setAttribute('aria-expanded', String(!children.hidden));
      });
      toggle.className = 'tree-toggle';
      toggle.setAttribute('aria-label', 'Toggle ' + name);
      toggle.setAttribute('aria-expanded', String(expanded.has(id)));
      row.append(toggle);
      if (expanded.has(id)) {
        children.hidden = false;
        renderChildren();
      }
    } else row.append(element('span', undefined, 'tree-indent'));
    const actions = element('div', undefined, 'tree-actions');
    actions.append(button('Edit', () => edit('set', record, path, current)));
    if (branch(current)) actions.append(button('Add child', () => edit('add', record, path, current)));
    actions.append(button('Delete', () => edit('remove', record, path, current)));
    row.append(label, sample, actions);
    for (const control of row.querySelectorAll('button')) {
      control.dataset.treeControl = JSON.stringify([id, control.className === 'tree-toggle' ? 'toggle' : control.textContent]);
      if (control.className !== 'tree-toggle') control.setAttribute('aria-label', control.textContent + ' ' + name);
    }
    node.append(row, children);
    return node;
  }

  function render() {
    const active = document.activeElement;
    const restoreFocus = list.contains(active);
    const control = active?.dataset.treeControl;
    const nodes = rows.slice(0, pageSize).map(record => item(record, [], record.id, record.data));
    list.replaceChildren(...(nodes.length ? nodes : [element('li', 'No documents yet.', 'tree-empty')]));
    if (restoreFocus) {
      const replacement = control && [...list.querySelectorAll('button')].find(button => button.dataset.treeControl === control);
      (replacement || addDocument).focus();
    }
    pageText.textContent = rows.length ? `Documents ${offset + 1}–${offset + nodes.length}` : '0 documents';
    previous.disabled = offset === 0;
    next.disabled = rows.length <= pageSize;
  }
  async function refresh() {
    if (disposed) return;
    if (refreshing) { refreshAgain = true; return; }
    refreshing = true;
    try {
      do {
        refreshAgain = false;
        const current = offset;
        const result = await api(records + '?limit=' + (pageSize + 1) + '&offset=' + current);
        if (disposed) return;
        if (current !== offset) { refreshAgain = true; continue; }
        if (!result.length && offset) { offset -= pageSize; refreshAgain = true; continue; }
        loaded = true;
        rows = result;
        render();
        if (editing?.record) {
          const currentRecord = rows.find(record => record.id === editing.record.id);
          if (currentRecord && currentRecord.updated !== editing.record.updated) warning.textContent = 'This document changed. Reopen it before saving.';
        }
      } while (refreshAgain && !disposed);
    } catch (error) { if (!disposed) notice(error.message); }
    finally { refreshing = false; }
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(() => { timer = null; void refresh(); }, 800);
  }
  const addDocument = button('Add document', () => edit('create', null, [], {}));
  addDocument.className = 'primary';
  toolbar.append(addDocument, button('Refresh data', refresh));
  function turnPage(direction) {
    offset = Math.max(0, offset + direction * pageSize);
    previous.disabled = next.disabled = true;
    void refresh();
  }
  const previous = button('Previous', () => turnPage(-1));
  const next = button('Next', () => turnPage(1));
  previous.disabled = next.disabled = true;
  paging.append(pageText, previous, next);
  const stream = new EventSource('/api/' + base + '/events/' + collection);
  stream.onopen = () => {
    status.textContent = 'Live';
    status.dataset.live = 'true';
    schedule();
  };
  stream.onerror = () => {
    status.textContent = stream.readyState === EventSource.CLOSED ? 'Live connection closed' : 'Reconnecting…';
    delete status.dataset.live;
    if (!loaded) schedule();
  };
  stream.addEventListener('change', schedule);
  void refresh();

  return {
    panel,
    close() {
      disposed = true;
      clearTimeout(timer);
      stream.close();
    }
  };
}
