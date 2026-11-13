import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, statfsSync } from 'node:fs';
import { join } from 'node:path';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function ensureSpace(path, minimum = 64 * 1024 * 1024) {
  const disk = statfsSync(path);
  if (disk.bavail * disk.bsize < minimum) throw new HttpError(507, 'Free space is too low for this operation.');
}

export function openStore(home) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(home, 'control.sqlite'));
  db.exec(`
    PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, time INTEGER NOT NULL, action TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS metrics (time INTEGER PRIMARY KEY, sample TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, config TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS releases (id TEXT PRIMARY KEY, project TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, info TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS databases (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, config TEXT NOT NULL);
  `);
  const keyFile = join(home, 'master.key');
  try { writeFileSync(keyFile, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const key = readFileSync(keyFile);
  if (key.length !== 32) throw new Error('Invalid installation encryption key.');
  const get = name => JSON.parse(db.prepare('SELECT value FROM settings WHERE key=?').get(name)?.value ?? 'null');
  const set = (name, value) => db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(name, JSON.stringify(value));
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      db.exec('COMMIT');
      return value;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  function audit(action) {
    db.prepare('INSERT INTO audit(time,action) VALUES (?,?)').run(Date.now(), action);
    db.exec('DELETE FROM audit WHERE id <= (SELECT max(id)-2000 FROM audit)');
  }
  return { db, key, home, get, set, transaction, audit };
}
