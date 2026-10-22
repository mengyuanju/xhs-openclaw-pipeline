import { randomUUID } from 'node:crypto';
import * as filesystem from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';

const MAX_BYTES = 128 * 1024 ** 2;
const UNSUPPORTED_SYNC = new Set(['EINVAL', 'ENOTSUP', 'ENOSYS', 'EPERM']);

function publicationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function optionalStat(fs, path) {
  return fs.lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
}

async function canonicalTarget(path, fs) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw new TypeError('Immutable publication path must be absolute');
  const parent = dirname(path), metadata = await fs.lstat(parent);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new TypeError('Immutable publication directory must be a real directory');
  const directory = await fs.realpath(parent);
  return { directory, path: join(directory, basename(path)) };
}

async function acquireLock(path, { fs, signal, lockTimeoutMs, pollIntervalMs }) {
  const lockPath = `${path}.publish.lock`, started = Date.now();
  const busy = code => code === 'EEXIST' || (process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(code));
  while (true) {
    signal?.throwIfAborted();
    let handle;
    try { handle = await fs.open(lockPath, 'wx', 0o600); }
    catch (error) {
      // Windows may report EPERM while the previous owner's closed lock is
      // pending deletion; retry it under the same bounded timeout as EEXIST.
      if (!busy(error.code)) throw error;
      const existing = await optionalStat(fs, lockPath).catch(error => { if (busy(error.code)) return null; throw error; });
      if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
        throw publicationError('IMMUTABLE_FILE_LOCK_INVALID', `发布锁不是普通文件：${lockPath}`);
      }
      if (Date.now() - started >= lockTimeoutMs) {
        throw publicationError('IMMUTABLE_FILE_BUSY', `文件发布锁等待超时：${lockPath}；请确认写入进程已停止后，人工清理遗留锁文件`);
      }
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
      continue;
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, token: randomUUID(), createdAt: new Date().toISOString() }));
      return { handle, lockPath };
    } catch (error) {
      await handle.close().catch(() => {});
      await fs.unlink(lockPath).catch(() => {});
      throw error;
    }
  }
}

/**
 * All writers/removers of an immutable path must use this same lock. Never
 * steal an existing lock: a timed-out writer may still be doing filesystem IO.
 */
export async function withImmutableFileLock(inputPath, operation, {
  fs = filesystem, signal, lockTimeoutMs = 10_000, pollIntervalMs = 10,
} = {}) {
  if (!Number.isFinite(lockTimeoutMs) || lockTimeoutMs < 0 || !Number.isFinite(pollIntervalMs) || pollIntervalMs < 1) throw new TypeError('Invalid immutable publication lock timeout');
  signal?.throwIfAborted();
  const target = await canonicalTarget(inputPath, fs);
  const lock = await acquireLock(target.path, { fs, signal, lockTimeoutMs, pollIntervalMs });
  try {
    signal?.throwIfAborted();
    return await operation({ ...target, fs });
  } finally {
    try { await lock.handle.close(); }
    finally { await fs.unlink(lock.lockPath); }
  }
}

async function syncIfSupported(handle) {
  try { await handle.sync(); }
  catch (error) {
    // Some removable filesystems cannot flush a handle explicitly. Complete
    // write+close still precedes rename, so readers never observe partial data.
    if (!UNSUPPORTED_SYNC.has(error.code)) throw error;
  }
}

/**
 * Publish complete bytes without hard links or replacing an existing file.
 * The temporary file and exclusive lock share the destination filesystem.
 */
export async function publishImmutableFile(inputPath, contents, options = {}) {
  if (typeof contents !== 'string' && !Buffer.isBuffer(contents) && !(contents instanceof Uint8Array)) throw new TypeError('Immutable publication contents must be text or bytes');
  const bytes = Buffer.from(contents), maxBytes = options.maxBytes ?? MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || bytes.length > maxBytes) throw new RangeError('Immutable publication exceeds its byte limit');
  return withImmutableFileLock(inputPath, async ({ path, directory, fs }) => {
    let temporary;
    const existingResult = async () => {
      const metadata = await optionalStat(fs, path);
      if (!metadata) return null;
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maxBytes) {
        throw publicationError('IMMUTABLE_FILE_CONFLICT', '已有目标不是有效的不可变文件');
      }
      const existing = await fs.readFile(path);
      const matches = options.compareExisting
        ? await options.compareExisting(path, existing) : existing.equals(bytes);
      if (!matches) throw publicationError('IMMUTABLE_FILE_CONFLICT', '已有不可变文件与此次内容不一致');
      return { created: false };
    };
    try {
      const existing = await existingResult();
      if (existing) return existing;
      options.signal?.throwIfAborted();
      temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(bytes); await syncIfSupported(handle); }
      finally { await handle.close(); }
      options.signal?.throwIfAborted();
      // Cooperative writers are serialized by the lock. Recheck just before
      // rename so an already-existing destination is never deliberately replaced.
      const appeared = await existingResult();
      if (appeared) return appeared;
      await fs.rename(temporary, path);
      temporary = null;
      return { created: true };
    } finally {
      if (temporary) await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }, options);
}
