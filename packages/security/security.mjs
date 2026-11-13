import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { HttpError } from '../core/store.mjs';

const derive = promisify(scrypt);
const work = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
export const token = (size = 32) => randomBytes(size).toString('base64url');
export const digest = value => createHash('sha256').update(value).digest('hex');
export function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export async function passwordHash(password) {
  const salt = token(16);
  return `${salt}:${(await derive(password, salt, 64, work)).toString('hex')}`;
}
export async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || password.length > 256) return false;
  const [salt, expected] = (encoded || 'dummy-phonecloud-salt:').split(':');
  return equal((await derive(password, salt, 64, work)).toString('hex'), expected);
}
export function strongPassword(value) {
  if (typeof value !== 'string' || value.length < 14 || value.length > 256) {
    throw new HttpError(400, 'Use a password with 14 to 256 characters.');
  }
}
export function seal(key, value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}
export function unseal(key, value) {
  if (!value) return {};
  const data = Buffer.from(value, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]));
}
export function rateLimiter(limit, windowMs) {
  const entries = new Map();
  return key => {
    const now = Date.now();
    for (const [id, entry] of entries) if (entry.until <= now) entries.delete(id);
    const entry = entries.get(key) || { count: 0, until: now + windowMs };
    if (entry.count >= limit || entries.size >= 1024 && !entries.has(key)) throw new HttpError(429, 'Too many requests. Try again later.');
    entry.count++;
    entries.set(key, entry);
  };
}
