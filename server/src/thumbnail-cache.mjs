import { lstat, opendir, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { derivedDirectory } from './derived-storage-paths.mjs';

const TASK_DIRECTORY = /^[1-9][0-9]*$/u;
const IMAGE = /^[1-9][0-9]*-[a-f0-9]{64}-thumb-480-v[1-9][0-9]*\.webp$/u;
const PARTIAL = /^[1-9][0-9]*-[a-f0-9]{64}-thumb-480-v[1-9][0-9]*\.webp\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/u;

/** Bounded, request-triggered sweeps discover old cache entries incrementally.
 * Originals and unknown files are never candidates. Active readers/generators pin paths.
 */
export function createThumbnailCache(storageRoot, {
  maxBytes = 512 * 1024 ** 2, maxFiles = 20_000, maxAgeMs = 7 * 24 * 60 * 60_000,
  sweepIntervalMs = 30_000, sweepEntries = 256, now = Date.now, logger = console,
} = {}) {
  if (![maxBytes, maxFiles, maxAgeMs, sweepEntries].every(value => Number.isSafeInteger(value) && value > 0)
    || !Number.isFinite(sweepIntervalMs) || sweepIntervalMs < 0) throw new TypeError('Invalid thumbnail cache limits');
  const entries = new Map(), pins = new Map(), deleting = new Map();
  let bytes = 0, rootIterator, taskIterator, taskPath, rootPath, flight, lastSweep = -Infinity, stopped = false, followup = false;
  function remember(path, info, accessed = false) {
    const old = entries.get(path); if (old) bytes -= old.size;
    entries.set(path, { size: info.size, usedAt: accessed ? now() : old?.usedAt ?? info.mtimeMs });
    bytes += info.size;
  }
  async function closeWalker() {
    await taskIterator?.close().catch(() => {}); taskIterator = null;
    await rootIterator?.close().catch(() => {}); rootIterator = null;
  }
  async function nextEntry() {
    if (!rootIterator) {
      rootPath = await derivedDirectory(storageRoot, 'thumbnails', { create: false });
      if (!rootPath) return null;
      rootIterator = await opendir(rootPath);
    }
    if (taskIterator) {
      const entry = await taskIterator.read();
      if (entry) return { entry, path: join(taskPath, entry.name) };
      await taskIterator.close(); taskIterator = null;
    }
    const directory = await rootIterator.read();
    if (!directory) { await closeWalker(); return null; }
    if (directory.isDirectory() && TASK_DIRECTORY.test(directory.name)
      && Number.isSafeInteger(Number(directory.name))) {
      taskPath = await derivedDirectory(rootPath, directory.name, { create: false });
      if (taskPath) taskIterator = await opendir(taskPath);
    }
    return { entry: directory, path: null };
  }
  function remove(path) {
    if (pins.has(path)) return Promise.resolve(false);
    if (deleting.has(path)) return deleting.get(path);
    const work = (async () => { try {
      const name = basename(path), task = basename(dirname(path));
      if (!IMAGE.test(name) && !PARTIAL.test(name) || !TASK_DIRECTORY.test(task) || !Number.isSafeInteger(Number(task))) return false;
      const root = await derivedDirectory(storageRoot, 'thumbnails', { create: false });
      if (!root) return false;
      const directory = await derivedDirectory(root, task, { create: false });
      if (!directory || join(directory, name) !== path) return false;
      // unlink semantics: never recurse through a changed directory or a link.
      const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (info && (!info.isFile() || info.isSymbolicLink())) return false;
      if (pins.has(path)) return false;
      await rm(path, { force: true });
      const old = entries.get(path); if (old) { bytes -= old.size; entries.delete(path); }
      return true;
    } catch (error) {
      if (!['EBUSY', 'EPERM', 'EACCES', 'ENOENT'].includes(error.code)) throw error;
      return false;
    } })().finally(() => { deleting.delete(path); });
    deleting.set(path, work);
    return work;
  }
  async function runSweep() {
    let scanned = 0, removed = 0;
    while (!stopped && scanned < sweepEntries) {
      const item = await nextEntry(); if (!item) break;
      scanned += 1;
      if (!item.path || !item.entry.isFile() || !IMAGE.test(item.entry.name) && !PARTIAL.test(item.entry.name)) continue;
      const info = await lstat(item.path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!info?.isFile() || info.isSymbolicLink()) continue;
      if (PARTIAL.test(item.entry.name)) {
        if (now() - info.mtimeMs > 60 * 60_000 && await remove(item.path)) removed += 1;
      } else remember(item.path, info);
    }
    // The index only covers entries seen by this process. Startup discovery is
    // bounded too, so existing large caches converge over successive requests.
    for (const [path, info] of [...entries].sort((a, b) => a[1].usedAt - b[1].usedAt)) {
      if (removed >= sweepEntries) break;
      if (bytes <= maxBytes && entries.size <= maxFiles && now() - info.usedAt <= maxAgeMs) break;
      if (await remove(path)) removed += 1;
    }
    return { scanned, removed, knownBytes: bytes, knownFiles: entries.size, discoveryPending: Boolean(rootIterator) };
  }
  function sweep() {
    if (stopped) return Promise.resolve({ scanned: 0, removed: 0, knownBytes: bytes, knownFiles: entries.size });
    if (flight) return flight;
    lastSweep = now();
    followup = false;
    flight = runSweep().finally(() => { flight = null; if (followup) kick(); });
    return flight;
  }
  function kick() {
    if (stopped) return;
    const overLimit = bytes > maxBytes || entries.size > maxFiles;
    if (flight) { if (overLimit) followup = true; return; }
    if (overLimit || now() - lastSweep >= sweepIntervalMs) void sweep().catch(error => logger.error?.('thumbnail cache cleanup deferred', { code: error.code ?? 'CACHE_CLEANUP_ERROR' }));
  }
  return {
    remember,
    async pin(path) {
      // Windows temp roots may use an 8.3 alias; generation and sweeps use the
      // canonical parent so every spelling must share the same reader pin.
      path = join(await realpath(dirname(path)), basename(path));
      while (deleting.has(path)) await deleting.get(path);
      pins.set(path, (pins.get(path) ?? 0) + 1);
      let released = false;
      return () => { if (released) return; released = true; const count = pins.get(path) - 1; if (count) pins.set(path, count); else pins.delete(path); if (bytes > maxBytes || entries.size > maxFiles) kick(); };
    },
    kick,
    sweep,
    async dispose() { stopped = true; await flight?.catch(() => {}); await closeWalker(); },
  };
}
