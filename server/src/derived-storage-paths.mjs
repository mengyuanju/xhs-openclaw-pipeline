import { lstat, mkdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

function samePath(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** Refuse links at each derived directory; callers only supply fixed or validated segments. */
export async function derivedDirectory(parent, segment, { create = true } = {}) {
  if (typeof segment !== 'string' || !/^[a-zA-Z0-9_.-]+$/u.test(segment) || segment === '.' || segment === '..') {
    throw new TypeError('Invalid derived storage directory');
  }
  const canonicalParent = await realpath(resolve(parent));
  const path = join(canonicalParent, segment);
  let info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!info && create) {
    await mkdir(path).catch(error => { if (error.code !== 'EEXIST') throw error; });
    info = await lstat(path);
  }
  if (!info) return null;
  if (info.isSymbolicLink() || !info.isDirectory() || !samePath(await realpath(path), path)) {
    throw new TypeError('Derived storage directory must not be a link');
  }
  return path;
}
