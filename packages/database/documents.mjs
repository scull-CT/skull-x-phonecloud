import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { HttpError, ensureSpace } from '../core/store.mjs';
import { requiredText, json, jsonBody } from '../core/http.mjs';
import { digest, token, passwordHash, strongPassword, verifyPassword, rateLimiter } from '../security/security.mjs';
import { editPath } from './path-edit.mjs';

const namePattern = /^[a-z][a-z0-9_]{0,47}$/;
const idPattern = /^[a-f0-9-]{36}$/;
const fieldTypes = { string: 'text', number: ['integer', 'real'], boolean: ['true', 'false'] };
const fieldPath = name => `'$."${name}"'`;
const parseRecord = row => ({ id: row.id, data: JSON.parse(row.data), updated: row.updated });

export function documentService(store) {
  const dir = join(store.home, 'databases');
  mkdirSync(dir, { recursive: true });
  const connections = new Map();
  const subscribers = new Set();
  const limit = rateLimiter(15, 60000);
  const publicLimit = rateLimiter(600, 60000);
  function entry(id) {
    const row = store.db.prepare('SELECT * FROM databases WHERE id=?').get(id);
    if (!row) throw new HttpError(404, 'Database not found.');
    return { id, name: row.name, ...JSON.parse(row.config) };
  }
  function open(id) {
    if (connections.has(id)) return connections.get(id);
    const db = new DatabaseSync(join(dir, id + '.sqlite'));
    db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS collections (name TEXT PRIMARY KEY, rules TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records (id TEXT NOT NULL, collection TEXT REFERENCES collections(name), data TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY(collection,id));
      CREATE TABLE IF NOT EXISTS keys (hash TEXT PRIMARY KEY, label TEXT NOT NULL, permission TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS users (name TEXT PRIMARY KEY, password TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, name TEXT NOT NULL, expires INTEGER NOT NULL);
    `);
    connections.set(id, db);
    return db;
  }
  function inspect(id) {
    const config = entry(id);
    const db = open(id);
    return { ...config, collections: db.prepare('SELECT * FROM collections ORDER BY name').all().map(row => ({ name: row.name, ...JSON.parse(row.rules) })),
      keys: db.prepare('SELECT label,permission FROM keys ORDER BY label').all(), users: db.prepare('SELECT name FROM users ORDER BY name').all().map(row => row.name),
      size: ['.sqlite', '.sqlite-wal'].reduce((sum, suffix) => sum + (statSync(join(dir, id + suffix), { throwIfNoEntry: false })?.size || 0), 0),
      subscribers: [...subscribers].filter(client => client.id === id).length };
  }
  function create(input) {
    const name = requiredText(input.name, 'database name', 60);
    if (store.db.prepare('SELECT count(*) AS n FROM databases').get().n >= 32) throw new HttpError(409, 'Database limit reached.');
    if (store.db.prepare('SELECT id FROM databases WHERE name=?').get(name)) throw new HttpError(409, 'Database name already exists.');
    const origin = input.origin || '';
    if (origin && (typeof origin !== 'string' || !/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(origin))) throw new HttpError(400, 'CORS must be a single HTTPS origin.');
    const id = randomUUID();
    open(id);
    store.db.prepare('INSERT INTO databases VALUES (?,?,?)').run(id, name, JSON.stringify({ origin }));
    store.audit('Database created ' + id);
    return inspect(id);
  }
  function define(db, input) {
    const name = input.name;
    const read = input.read || 'private';
    const write = input.write || 'private';
    const fields = input.fields || {};
    if (typeof name !== 'string' || !namePattern.test(name) || !['public', 'user', 'private'].includes(read) || !['user', 'private'].includes(write) ||
      !fields || typeof fields !== 'object' || Array.isArray(fields) || Object.keys(fields).length > 24) throw new HttpError(400, 'Invalid collection definition.');
    for (const [field, rule] of Object.entries(fields)) {
      if (!namePattern.test(field) || !rule || !Object.hasOwn(fieldTypes, rule.type)) throw new HttpError(400, 'Fields must have a string, number or boolean type.');
    }
    if (db.prepare('SELECT name FROM collections WHERE name=?').get(name)) throw new HttpError(409, 'Collection already exists.');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO collections VALUES (?,?)').run(name, JSON.stringify({ read, write, fields }));
      for (const [field, rule] of Object.entries(fields)) {
        if (rule.index || rule.unique) db.exec(`CREATE ${rule.unique ? 'UNIQUE ' : ''}INDEX "i:${name}:${field}" ON records(json_extract(data,${fieldPath(field)})) WHERE collection='${name}'`);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function rulesFor(db, collection) {
    const row = db.prepare('SELECT rules FROM collections WHERE name=?').get(collection);
    if (!row) throw new HttpError(404, 'Collection not found.');
    return JSON.parse(row.rules);
  }
  function checked(data, rules) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length > 100) throw new HttpError(400, 'Record must be a JSON object.');
    for (const [name, field] of Object.entries(rules.fields)) {
      if ((!Object.hasOwn(data, name) && field.required) || (Object.hasOwn(data, name) && typeof data[name] !== field.type)) throw new HttpError(400, 'Invalid or missing field: ' + name);
    }
    const value = JSON.stringify(data);
    if (Buffer.byteLength(value) > 32768) throw new HttpError(413, 'Record exceeds 32 KiB.');
    return value;
  }
  function publish(id, collection, type, record) {
    const payload = `event: change\ndata: ${JSON.stringify({ collection, type, record })}\n\n`;
    for (const client of subscribers) {
      if (client.id !== id || client.collection !== collection) continue;
      if (client.expires <= Date.now() || !client.authorize() || client.res.writableLength > 65536) client.res.end();
      else client.res.write(payload);
    }
  }
  function records(id, collection, method, recordId, input, params, capability) {
    const db = open(id);
    const rules = rulesFor(db, collection);
    const reading = method === 'GET';
    if (!capability && (!reading || rules.read !== 'public') || capability === 'read' && !reading ||
        capability === 'user' && (reading ? rules.read === 'private' : rules.write !== 'user')) throw new HttpError(403, 'Collection access denied.');
    if (recordId && !idPattern.test(recordId)) throw new HttpError(400, 'Invalid record ID.');
    if (reading && recordId) {
      const row = db.prepare('SELECT id,data,updated FROM records WHERE collection=? AND id=?').get(collection, recordId);
      if (!row) throw new HttpError(404, 'Record not found.');
      return parseRecord(row);
    }
    if (reading) {
      const size = Number(params.get('limit') || 50);
      const offset = Number(params.get('offset') || 0);
      if (!Number.isInteger(size) || size < 1 || size > 100 || !Number.isInteger(offset) || offset < 0 || offset > 100000) throw new HttpError(400, 'Invalid pagination.');
      const field = params.get('field');
      const order = params.get('order');
      if ([field, order].some(name => name && (!namePattern.test(name) || !Object.hasOwn(rules.fields, name)))) throw new HttpError(400, 'Filter and sort by a defined field.');
      const values = [collection];
      let condition = '';
      if (field) {
        let value;
        try { value = JSON.parse(params.get('value')); } catch { throw new HttpError(400, 'Filter value must be JSON.'); }
        if (typeof value !== rules.fields[field].type) throw new HttpError(400, 'Filter value has the wrong type.');
        condition = ` AND json_extract(data,${fieldPath(field)})=?`;
        values.push(typeof value === 'boolean' ? Number(value) : value);
      }
      const sort = order ? `json_extract(data,${fieldPath(order)})` : 'updated';
      const direction = params.get('direction') === 'asc' ? 'ASC' : 'DESC';
      return db.prepare(`SELECT id,data,updated FROM records WHERE collection=?${condition} ORDER BY ${sort} ${direction},id LIMIT ? OFFSET ?`).all(...values, size, offset).map(parseRecord);
    }
    ensureSpace(dir);
    if (method === 'DELETE' && recordId) {
      if (!db.prepare('DELETE FROM records WHERE collection=? AND id=?').run(collection, recordId).changes) throw new HttpError(404, 'Record not found.');
      publish(id, collection, 'delete', { id: recordId });
      return { id: recordId };
    }
    const replace = ['PUT', 'PATCH'].includes(method) && recordId;
    if (!(method === 'POST' && !recordId) && !replace) throw new HttpError(405, 'Unsupported record operation.');
    const idValue = recordId || randomUUID();
    const previous = replace && db.prepare('SELECT data,updated FROM records WHERE collection=? AND id=?').get(collection, idValue);
    if (replace && !previous) throw new HttpError(404, 'Record not found.');
    if (method === 'PATCH') {
      if (input.updated !== previous.updated) {
        throw new HttpError(409, 'This document changed. Reopen it before editing.');
      }
      if (input.action === 'remove' && Array.isArray(input.path) && !input.path.length) throw new HttpError(400, 'Use DELETE to remove a document.');
      input = editPath(JSON.parse(previous.data), input);
    }
    const data = checked(input, rules);
    const updated = Math.max(Date.now(), (previous?.updated ?? 0) + 1);
    try {
      if (replace) {
        if (!db.prepare('UPDATE records SET data=?,updated=? WHERE collection=? AND id=?').run(data, updated, collection, idValue).changes) throw new HttpError(404, 'Record not found.');
      } else db.prepare('INSERT INTO records VALUES (?,?,?,?)').run(idValue, collection, data, updated);
    } catch (error) { if (error.errcode === 2067) throw new HttpError(409, 'A unique field already has that value.'); throw error; }
    const record = { id: idValue, data: input, updated };
    publish(id, collection, replace ? 'update' : 'create', record);
    return record;
  }
  function stream(id, collection, res, expires = Date.now() + 1800000, authorize = () => true) {
    if (subscribers.size >= 48) throw new HttpError(429, 'Realtime client limit reached.');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    res.write(': connected\n\n');
    const client = { id, collection, res, expires: Math.min(expires, Date.now() + 1800000), authorize };
    subscribers.add(client);
    const pulse = setInterval(() => {
      if (client.expires <= Date.now() || !authorize() || res.writableLength > 65536) res.end();
      else res.write(': heartbeat\n\n');
    }, 15000);
    res.on('close', () => { clearInterval(pulse); subscribers.delete(client); });
  }
  async function admin(id, parts, req, res, params, authorize) {
    entry(id);
    const db = open(id);
    const [section, collection, recordId] = parts;
    if (!section && req.method === 'GET') return json(res, inspect(id));
    if (section === 'collections' && req.method === 'POST') {
      define(db, await jsonBody(req));
      store.audit('Collection created ' + id);
      return json(res, inspect(id), 201);
    }
    if (section === 'collections' && req.method === 'PUT' && collection) {
      const { read, write } = await jsonBody(req, 4096);
      if (!['public', 'user', 'private'].includes(read) || !['user', 'private'].includes(write)) throw new HttpError(400, 'Invalid collection permissions.');
      const rules = rulesFor(db, collection);
      db.prepare('UPDATE collections SET rules=? WHERE name=?').run(JSON.stringify({ ...rules, read, write }), collection);
      for (const client of subscribers) if (client.id === id && client.collection === collection) client.res.end();
      store.audit('Collection permissions changed ' + id);
      return json(res, inspect(id));
    }
    if (section === 'keys' && ['POST', 'DELETE'].includes(req.method)) {
      const input = await jsonBody(req);
      const label = requiredText(input.label, 'key label', 80);
      if (req.method === 'DELETE') {
        db.prepare('DELETE FROM keys WHERE label=?').run(label);
        for (const client of subscribers) if (client.id === id) client.res.end();
        store.audit('Database key revoked ' + id);
        return json(res, { ok: true });
      }
      if (!['read', 'write'].includes(input.permission)) throw new HttpError(400, 'Choose read or write.');
      if (db.prepare('SELECT label FROM keys WHERE label=?').get(label)) throw new HttpError(409, 'Key label already exists.');
      const key = token();
      db.prepare('INSERT INTO keys VALUES (?,?,?)').run(digest(key), label, input.permission);
      store.audit('Database key created ' + id);
      return json(res, { key }, 201);
    }
    if (section === 'users' && ['POST', 'DELETE'].includes(req.method)) {
      const input = await jsonBody(req);
      const name = requiredText(input.name, 'username', 80);
      if (req.method === 'DELETE') {
        db.prepare('DELETE FROM users WHERE name=?').run(name);
        db.prepare('DELETE FROM tokens WHERE name=?').run(name);
        for (const client of subscribers) if (client.id === id) client.res.end();
      } else {
        strongPassword(input.password);
        const password = await passwordHash(input.password);
        if (db.prepare('SELECT name FROM users WHERE name=?').get(name)) throw new HttpError(409, 'Username already exists.');
        db.prepare('INSERT INTO users VALUES (?,?)').run(name, password);
      }
      store.audit('Database user changed ' + id);
      return json(res, { ok: true });
    }
    if (section === 'records') {
      const input = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await jsonBody(req) : null;
      if (req.method === 'DELETE' && params.has('updated')) {
        const row = db.prepare('SELECT updated FROM records WHERE collection=? AND id=?').get(collection, recordId);
        if (row && String(row.updated) !== params.get('updated')) throw new HttpError(409, 'This document changed. Reopen it before deleting.');
      }
      return json(res, records(id, collection, req.method, recordId, input, params, 'write'));
    }
    if (section === 'events' && req.method === 'GET') { rulesFor(db, collection); return stream(id, collection, res, undefined, authorize); }
    if (section === 'exchange' && req.method === 'GET') {
      const data = db.prepare('SELECT id,data,updated FROM records WHERE collection=? ORDER BY id LIMIT 1001').all(collection).map(parseRecord);
      rulesFor(db, collection);
      if (data.length > 1000) throw new HttpError(413, 'Export limit is 1,000 records. Use a SQLite backup for larger collections.');
      return json(res, data.map(item => item.data));
    }
    if (section === 'exchange' && req.method === 'POST') {
      const { rows } = await jsonBody(req, 2 * 1024 * 1024);
      if (!Array.isArray(rows) || rows.length > 1000) throw new HttpError(400, 'Send up to 1,000 records.');
      ensureSpace(dir);
      const rules = rulesFor(db, collection);
      const insert = db.prepare('INSERT INTO records VALUES (?,?,?,?)');
      const changes = [];
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const data of rows) {
          const id = randomUUID();
          const updated = Date.now();
          insert.run(id, collection, checked(data, rules), updated);
          changes.push({ id, data, updated });
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        if (error.errcode === 2067) throw new HttpError(409, 'Import violates a unique field.');
        throw error;
      }
      for (const record of changes) publish(id, collection, 'create', record);
      return json(res, { imported: changes.length }, 201);
    }
    throw new HttpError(404, 'Database operation not found.');
  }
  async function external(id, parts, req, res, params) {
    publicLimit(id);
    const config = entry(id);
    const db = open(id);
    if (req.headers.origin && config.origin === req.headers.origin) {
      res.setHeader('Access-Control-Allow-Origin', config.origin);
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE', 'Access-Control-Allow-Headers': 'Authorization,Content-Type' });
        return res.end();
      }
    }
    const [section, collection, recordId] = parts;
    if (section === 'login' && req.method === 'POST') {
      limit(id);
      const input = await jsonBody(req, 4096);
      const name = requiredText(input.name, 'username', 80);
      const user = db.prepare('SELECT password FROM users WHERE name=?').get(name);
      if (!(await verifyPassword(input.password, user?.password)) || !user || db.prepare('SELECT password FROM users WHERE name=?').get(name)?.password !== user.password) {
        throw new HttpError(401, 'Invalid username or password.');
      }
      const credential = token();
      const expires = Date.now() + 12 * 3600000;
      db.prepare('DELETE FROM tokens WHERE expires<=?').run(Date.now());
      db.prepare('INSERT INTO tokens VALUES (?,?,?)').run(digest(credential), name, expires);
      return json(res, { token: credential, expires });
    }
    let capability = null;
    let expires;
    if (req.headers.authorization) {
      const raw = req.headers.authorization.match(/^Bearer ([\w-]{43})$/)?.[1];
      if (!raw) throw new HttpError(401, 'Invalid bearer credential.');
      const hash = digest(raw);
      const key = db.prepare('SELECT permission FROM keys WHERE hash=?').get(hash);
      const user = db.prepare('SELECT expires FROM tokens WHERE hash=? AND expires>?').get(hash, Date.now());
      capability = key?.permission || (user && 'user');
      expires = user?.expires;
      if (!capability) throw new HttpError(401, 'Invalid bearer credential.');
    }
    if (section === 'events' && req.method === 'GET') {
      const rules = rulesFor(db, collection);
      if (!capability && rules.read !== 'public' || capability === 'user' && rules.read === 'private') throw new HttpError(403, 'Collection access denied.');
      return stream(id, collection, res, expires);
    }
    if (section === 'records') {
      if (!capability && req.method !== 'GET') throw new HttpError(403, 'Authentication required.');
      const input = ['POST', 'PUT'].includes(req.method) ? await jsonBody(req, 65536) : null;
      return json(res, records(id, collection, req.method, recordId, input, params, capability));
    }
    throw new HttpError(404, 'Database endpoint not found.');
  }
  return {
    create, inspect, admin, external,
    list: () => store.db.prepare('SELECT id,name FROM databases ORDER BY name').all(),
    count: () => subscribers.size,
    disconnect() { for (const client of subscribers) client.res.end(); },
    close() { for (const db of connections.values()) db.close(); }
  };
}
