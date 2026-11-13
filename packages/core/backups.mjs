import { backup, DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, lstatSync, statSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ensureSpace, HttpError } from './store.mjs';

const maxBytes = 64 * 1024 * 1024;
const header = Buffer.from('PHONECLOUD1\n');
const kdf = (password, salt) => scryptSync(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const passwordCheck = password => {
  if (typeof password !== 'string' || password.length < 16 || password.length > 256) throw new HttpError(400, 'Backup passphrase must have 16 to 256 characters.');
};
const validPath = path => typeof path === 'string' && path.length <= 1000 && path.split('/').every(part =>
  /^[A-Za-z0-9_.@+-]{1,180}$/.test(part) && !part.endsWith('.') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));

function snapshot(source, target) {
  const db = new DatabaseSync(source, { readOnly: true });
  return backup(db, target).finally(() => db.close());
}

export async function createBackup(home, destination, password) {
  passwordCheck(password);
  ensureSpace(home, 128 * 1024 * 1024);
  if (existsSync(destination)) throw new HttpError(409, 'Choose a new backup filename.');
  const scratch = mkdtempSync(join(home, '.backup-'));
  const files = [];
  let total = 0;
  function add(relative, file) {
    if (!validPath(relative)) throw new HttpError(409, 'Backup contains an unsupported filename.');
    const size = statSync(file).size;
    total += size;
    if (total > maxBytes || files.length >= 12000) throw new HttpError(413, 'Backup exceeds the 64 MiB or 12,000-file limit.');
    files.push([relative, readFileSync(file).toString('base64')]);
  }
  function walk(relative, base) {
    const full = join(base, relative);
    if (!existsSync(full)) return;
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) throw new HttpError(409, 'Backup cannot include symbolic links.');
    if (stat.isFile()) add(relative, full);
    if (stat.isDirectory()) {
      for (const name of readdirSync(full)) walk(relative + '/' + name, base);
    }
  }
  try {
    add('master.key', join(home, 'master.key'));
    await snapshot(join(home, 'control.sqlite'), join(scratch, 'control.sqlite'));
    add('control.sqlite', join(scratch, 'control.sqlite'));
    const db = new DatabaseSync(join(scratch, 'control.sqlite'));
    let databases;
    let projectRows;
    try {
      databases = db.prepare('SELECT id FROM databases').all();
      projectRows = db.prepare('SELECT id FROM projects').all();
      db.exec('DELETE FROM sessions; VACUUM;');
    } finally { db.close(); }
    files[1][1] = readFileSync(join(scratch, 'control.sqlite')).toString('base64');
    for (const { id } of databases) {
      const relative = `databases/${id}.sqlite`;
      const temp = join(scratch, id + '.sqlite');
      await snapshot(join(home, relative), temp);
      add(relative, temp);
    }
    for (const { id } of projectRows) {
      for (const area of ['source', 'data']) walk(`projects/${id}/${area}`, home);
    }
    const salt = randomBytes(16);
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', kdf(password, salt), nonce);
    cipher.setAAD(header);
    const payload = gzipSync(JSON.stringify({ created: Date.now(), files }));
    const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
    writeFileSync(destination, Buffer.concat([header, salt, nonce, cipher.getAuthTag(), encrypted]), { flag: 'wx', mode: 0o600 });
    return { filename: destination.split(/[\\/]/).at(-1), files: files.length, bytes: total };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

export function openBackup(file, password) {
  passwordCheck(password);
  if (statSync(file).size > maxBytes * 2) throw new HttpError(413, 'Backup file is too large.');
  try {
    const archive = readFileSync(file);
    if (!archive.subarray(0, header.length).equals(header)) throw new Error();
    const offset = header.length;
    const decipher = createDecipheriv('aes-256-gcm', kdf(password, archive.subarray(offset, offset + 16)), archive.subarray(offset + 16, offset + 28));
    decipher.setAAD(header);
    decipher.setAuthTag(archive.subarray(offset + 28, offset + 44));
    const decoded = Buffer.concat([decipher.update(archive.subarray(offset + 44)), decipher.final()]);
    const payload = JSON.parse(gunzipSync(decoded, { maxOutputLength: maxBytes * 2 }));
    const names = new Set();
    let size = 0;
    if (!Array.isArray(payload.files) || payload.files.length > 12000) throw new Error();
    for (const [path, data] of payload.files) {
      if (!validPath(path) || names.has(path.toLowerCase()) || !/^(?:control\.sqlite|master\.key|databases\/[a-f0-9-]{36}\.sqlite|projects\/[a-f0-9-]{36}\/(?:data|source)\/.+)$/.test(path) || typeof data !== 'string') throw new Error();
      names.add(path.toLowerCase());
      size += Buffer.byteLength(data, 'base64');
      if (size > maxBytes) throw new Error();
    }
    if (!names.has('master.key') || !names.has('control.sqlite')) throw new Error();
    return { ...payload, size };
  } catch { throw new HttpError(400, 'Backup is damaged, unsupported or the passphrase is incorrect.'); }
}

export function restoreBackup(home, file, password, preview) {
  const { files, size, created } = openBackup(file, password);
  const parent = resolve(home, '..');
  mkdirSync(parent, { recursive: true });
  ensureSpace(parent, size + 64 * 1024 * 1024);
  const staging = mkdtempSync(join(parent, '.restore-'));
  try {
    for (const [path, encoded] of files) {
      const destination = join(staging, path);
      mkdirSync(resolve(destination, '..'), { recursive: true });
      writeFileSync(destination, Buffer.from(encoded, 'base64'), { flag: 'wx', mode: 0o600 });
    }
    if (statSync(join(staging, 'master.key')).size !== 32) throw new HttpError(400, 'Backup installation key is invalid.');
    let projects;
    let databases;
    for (const [path] of files.filter(([path]) => path.endsWith('.sqlite'))) {
      const db = new DatabaseSync(join(staging, path));
      try {
        if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new HttpError(400, 'SQLite integrity check failed.');
        if (path === 'control.sqlite') {
          projects = db.prepare('SELECT id,config FROM projects').all();
          databases = db.prepare('SELECT id,name FROM databases').all();
          if ([...projects, ...databases].some(row => !/^[a-f0-9-]{36}$/.test(row.id))) throw new HttpError(400, 'Backup contains an invalid project or database ID.');
          db.exec('DELETE FROM sessions; DELETE FROM releases;');
          const save = db.prepare('UPDATE projects SET config=? WHERE id=?');
          for (const row of projects) {
            const config = JSON.parse(row.config);
            save.run(JSON.stringify({ ...config, current: null, enabled: false }), row.id);
          }
        }
      } finally { db.close(); }
    }
    const summary = { created, bytes: size, files: files.length, projects: projects.length, databases: databases.length };
    for (const row of databases) if (!existsSync(join(staging, 'databases', row.id + '.sqlite'))) throw new HttpError(400, 'Backup lacks a database snapshot.');
    if (preview) return summary;
    for (const row of projects) {
      for (const folder of ['source', 'data', 'releases']) mkdirSync(join(staging, 'projects', row.id, folder), { recursive: true });
    }
    const previous = home + '.before-restore-' + randomUUID();
    const existed = existsSync(home);
    if (existed) renameSync(home, previous);
    try { renameSync(staging, home); }
    catch (error) { if (existed) renameSync(previous, home); throw error; }
    return { ...summary, previous: existed ? previous : null };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

export function backupJobs(store) {
  const dir = resolve(store.home, '..', 'backups');
  mkdirSync(dir, { recursive: true });
  let job;
  const list = () => readdirSync(dir).filter(name => /^phonecloud-[\w.-]+\.pcbackup$/.test(name))
    .sort().reverse().map(name => ({ name, bytes: statSync(join(dir, name)).size }));
  async function run(password, retention) {
    if (job) throw new HttpError(409, 'A backup is already running.');
    const file = join(dir, 'phonecloud-' + new Date().toISOString().replace(/:/g, '-') + '.pcbackup');
    job = createBackup(store.home, file, password);
    try {
      const result = await job;
      if (retention) for (const item of list().slice(retention)) rmSync(join(dir, item.name));
      store.audit('Encrypted backup created');
      return result;
    } finally { job = null; }
  }
  return { dir, list, run, async close() { if (job) await Promise.allSettled([job]); } };
}
