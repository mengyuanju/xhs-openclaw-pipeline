import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, open, opendir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ControlPlaneConflictError, normalizeTaskId } from './domain.mjs';
import { derivedDirectory } from './derived-storage-paths.mjs';
import { writeBatchTaskArchive, writeTaskArchive } from './task-archive.mjs';

/** Prepare complete ZIPs without retaining images or the archive in memory.
 * HTTP callers must recheck actors, ownership and delivery bindings before openStream().
 */
export function createTaskArchivePreparation({ storageRoot, concurrency = 2, maxQueued = 8,
  maxBytes = 2 * 1024 ** 3, timeoutMs = 120_000,
} = {}) {
  if (!storageRoot || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8
    || !Number.isSafeInteger(maxQueued) || maxQueued < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 1
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('Invalid archive preparation limits');
  const queue = [], jobs = new Set(), artifacts = new Set();
  const livePaths = new Set();
  let active = 0, stopping = false, sweepFlight = null, iterator = null, lastSweep = 0;
  async function sweep() {
    if (stopping) return;
    if (sweepFlight) return sweepFlight;
    lastSweep = Date.now();
    sweepFlight = (async () => {
      const root = await derivedDirectory(storageRoot, '.task-archives', { create: false });
      if (!root) return;
      iterator ??= await opendir(root);
      for (let scanned = 0; scanned < 64; scanned += 1) {
        const entry = await iterator.read();
        if (!entry) { await iterator.close(); iterator = null; break; }
        if (!entry.isFile() || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.zip$/u.test(entry.name)) continue;
        const path = join(root, entry.name);
        if (livePaths.has(path)) continue;
        const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (info?.isFile() && !info.isSymbolicLink() && Date.now() - info.mtimeMs > 60 * 60_000
          && !livePaths.has(path)) await rm(path, { force: true }).catch(error => { if (!['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) throw error; });
      }
    })().finally(() => { sweepFlight = null; });
    return sweepFlight;
  }
  async function stage(job) {
    const { signal } = job.controller;
    let path, file, diskFlight;
    try {
      signal.throwIfAborted();
      await mkdir(resolve(storageRoot), { recursive: true });
      const root = await derivedDirectory(storageRoot, '.task-archives');
      path = join(root, `${randomUUID()}.zip`);
      livePaths.add(path);
      // The disk pipeline owns cancellation and waits for the descriptor to
      // close. Avoid a second abort listener destroying the same file stream.
      file = createWriteStream(path, { flags: 'wx' });
      let bytes = 0;
      const bounded = new Transform({ transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        callback(bytes > maxBytes ? new ControlPlaneConflictError('ARCHIVE_TOO_LARGE', '资源包超过容量限制，请减少作业数量') : null, chunk);
      } });
      // Always observe the disk failure immediately; the ZIP writer also sees it.
      let diskError;
      diskFlight = pipeline(bounded, file, { signal }).catch(error => { diskError = error; bounded.destroy(error); });
      const result = job.batch
        ? await writeBatchTaskArchive(job.tasks, job.loadAsset, bounded, { maxTasks: job.maxTasks, signal })
        : await writeTaskArchive(job.tasks[0], job.loadAsset, bounded, { signal });
      await diskFlight;
      if (diskError) throw diskError;
      signal.throwIfAborted();
      const size = (await stat(path)).size;
      const streams = new Set();
      let disposed = false, disposal;
      const artifact = {
        path, size, taskCount: result.taskCount,
        async openStream() {
          if (disposed || stopping) throw new Error('Archive has been disposed');
          const metadata = await lstat(path);
          if (!metadata.isFile() || metadata.isSymbolicLink()) throw new TypeError('Invalid archive file');
          const handle = await open(path, 'r');
          if (disposed || stopping) { await handle.close(); throw new Error('Archive has been disposed'); }
          const stream = handle.createReadStream();
          streams.add(stream); stream.once('close', () => streams.delete(stream));
          return stream;
        },
        dispose() {
          if (disposal) return disposal;
          disposed = true;
          disposal = (async () => {
            await Promise.all([...streams].map(stream => new Promise(resolveClose => {
              if (stream.closed) return resolveClose();
              stream.once('close', resolveClose); stream.destroy();
            })));
            await rm(path, { force: true, maxRetries: 5, retryDelay: 100 });
            artifacts.delete(artifact); livePaths.delete(path);
          })();
          return disposal;
        },
      };
      artifacts.add(artifact);
      return artifact;
    } catch (error) {
      file?.destroy(); await diskFlight;
      if (path) await rm(path, { force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
      livePaths.delete(path);
      throw signal.aborted ? signal.reason : error;
    }
  }
  function drain() {
    while (!stopping && active < concurrency && queue.length) {
      const job = queue.shift(); active += 1; job.started = true;
      job.flight = stage(job).then(job.resolve, job.reject).finally(() => {
        active -= 1; clearTimeout(job.timer); job.signal?.removeEventListener('abort', job.onAbort);
        jobs.delete(job); drain();
      });
    }
  }
  function enqueue(tasks, loadAsset, { batch = false, maxTasks = 20, signal } = {}) {
    signal?.throwIfAborted();
    if (!Array.isArray(tasks) || !tasks.length || tasks.length > maxTasks) throw new RangeError('Invalid archive task count');
    for (const task of tasks) normalizeTaskId(task.id);
    if (stopping) throw new ControlPlaneConflictError('ARCHIVE_STOPPING', '资源包服务正在关闭');
    if (active >= concurrency && queue.length >= maxQueued) throw new ControlPlaneConflictError('ARCHIVE_BUSY', '资源包准备队列已满，请稍后重试');
    if (Date.now() - lastSweep > 15 * 60_000) void sweep().catch(() => {});
    return new Promise((resolveJob, reject) => {
      const controller = new AbortController();
      const job = { tasks, loadAsset, batch, maxTasks, signal, controller, resolve: resolveJob, reject, started: false };
      function cancel(reason) {
        controller.abort(reason);
        if (!job.started) {
          const index = queue.indexOf(job); if (index >= 0) queue.splice(index, 1);
          clearTimeout(job.timer); signal?.removeEventListener('abort', job.onAbort); jobs.delete(job); reject(reason);
        }
      }
      job.onAbort = () => cancel(signal.reason ?? new Error('Archive preparation aborted'));
      job.timer = setTimeout(() => cancel(new ControlPlaneConflictError('ARCHIVE_TIMEOUT', '资源包准备超时，请减少作业数量后重试')), timeoutMs);
      job.timer.unref?.(); signal?.addEventListener('abort', job.onAbort, { once: true });
      jobs.add(job); queue.push(job); drain();
    });
  }
  return {
    prepareTask: (task, loadAsset, options) => enqueue([task], loadAsset, { ...options, maxTasks: 1 }),
    prepareBatch: (tasks, loadAsset, options) => enqueue(tasks, loadAsset, { ...options, batch: true }),
    sweep,
    async dispose() {
      stopping = true;
      for (const job of jobs) {
        job.controller.abort(new Error('Archive preparation stopped'));
        if (!job.started) { clearTimeout(job.timer); job.signal?.removeEventListener('abort', job.onAbort); job.reject(job.controller.signal.reason); jobs.delete(job); }
      }
      queue.length = 0;
      await Promise.all([...jobs].map(job => job.flight));
      await Promise.all([...artifacts].map(artifact => artifact.dispose()));
      await sweepFlight?.catch(() => {}); await iterator?.close().catch(() => {}); iterator = null;
    },
  };
}
