import { isDeepStrictEqual } from 'node:util';
import { HttpError } from '../core/store.mjs';

const has = (node, key) => Object.hasOwn(node, key);
const container = value => value !== null && typeof value === 'object';

export function editPath(data, { path, action, value, expected }) {
  if (!Array.isArray(path) || path.length > 100 ||
      path.some(key => typeof key !== 'string' || key.length > 32768) ||
      !['add', 'set', 'remove'].includes(action)) throw new HttpError(400, 'Invalid JSON path operation.');
  if (action !== 'remove' && value === undefined) throw new HttpError(400, 'A JSON value is required.');
  if (!path.length) {
    if (action === 'add') throw new HttpError(400, 'Choose a child key.');
    if (!isDeepStrictEqual(data, expected)) throw new HttpError(409, 'This value changed. Reopen it before editing.');
    return value;
  }
  let parent = data;
  for (const key of path.slice(0, -1)) {
    if (!container(parent) || !has(parent, key) || Array.isArray(parent) && !/^(0|[1-9]\d*)$/.test(key)) {
      throw new HttpError(409, 'This path changed. Reopen it before editing.');
    }
    parent = parent[key];
  }
  if (!container(parent)) throw new HttpError(409, 'The parent is no longer an object or array.');
  const key = path.at(-1);
  const array = Array.isArray(parent);
  if (action === 'add') {
    if (array) {
      if (key !== '-') throw new HttpError(400, 'Use the append path for arrays.');
      parent.push(value);
    } else {
      if (has(parent, key)) throw new HttpError(409, 'That key already exists.');
      Object.defineProperty(parent, key, { value, enumerable: true, writable: true, configurable: true });
    }
    return data;
  }
  if (array && !/^(0|[1-9]\d*)$/.test(key) || !has(parent, key) || !isDeepStrictEqual(parent[key], expected)) {
    throw new HttpError(409, 'This value changed. Reopen it before editing.');
  }
  if (action === 'set') parent[key] = value;
  else if (array) parent.splice(Number(key), 1);
  else delete parent[key];
  return data;
}
