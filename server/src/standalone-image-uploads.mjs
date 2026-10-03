import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { normalizeUuid, normalizeTaskId, ControlPlaneConflictError } from './domain.mjs';
import { decodeReference, imageHash } from '../../src/image-edit-pixels.mjs';
import { STANDALONE_IMAGE_EDITOR_LIMITS as limits } from '../../src/standalone-image-editor-config.mjs';

const TTL_MS = 60 * 60_000;
const RECEIPT_NAME = /^[1-9]\d*-[0-9a-f-]{36}-[1-5]\.json$/u;
const DATA_NAME = /^[1-9]\d*-[0-9a-f-]{36}-[1-5]-[0-9a-f]{64}\.png$/u;
const HEX_HASH = /^[0-9a-f]{64}$/u;

function uploadIndex(value) {
  const index = Number(value);
  if (!Number.isSafeInteger(index) || index < 1 || index > limits.maxImages) throw new TypeError('图片序号无效');
  return index;
}

export function normalizeUploadManifest(value) {
  if (!Array.isArray(value) || !value.length || value.length > limits.maxImages) throw new TypeError('请上传 1 至 5 张图片');
  const uploads = value.map(item => ({ index: uploadIndex(item?.index), token: normalizeUuid(item?.token, 'upload token') }))
    .sort((left, right) => left.index - right.index);
  if (uploads.some((item, index) => item.index !== index + 1)) throw new TypeError('上传图片序号必须连续且不能重复');
  return uploads;
}

export function createUploadGate({ concurrency = 2, maxQueued = 64 } = {}) {
  let active = 0;
  let stopping = false;
  const waiting = [];
  const drained = [];
  async function acquire(signal) {
    signal?.throwIfAborted();
    if (stopping) throw new ControlPlaneConflictError('UPLOAD_STOPPING', '上传服务正在关闭，请稍后重试');
    if (active < concurrency) active += 1;
    else {
      if (waiting.length >= maxQueued) throw new ControlPlaneConflictError('UPLOAD_BUSY', '上传请求较多，请稍后重试');
      await new Promise((resolveSlot, reject) => {
        const entry = { grant: () => { signal?.removeEventListener('abort', abort); resolveSlot(); },
          reject: error => { signal?.removeEventListener('abort', abort); reject(error); } };
        const abort = () => {
          const index = waiting.indexOf(entry);
          if (index >= 0) waiting.splice(index, 1);
          reject(signal.reason ?? new DOMException('Upload aborted', 'AbortError'));
        };
        signal?.addEventListener('abort', abort, { once: true });
        waiting.push(entry);
      });
    }
    return () => {
      const next = waiting.shift();
      if (next) next.grant();
      else { active -= 1; if (!active) drained.splice(0).forEach(done => done()); }
    };
  }
  return {
    async run(action, { signal } = {}) {
      const release = await acquire(signal);
      try { signal?.throwIfAborted(); return await action(); }
      finally { release(); }
    },
    async dispose() {
      stopping = true;
      const error = new ControlPlaneConflictError('UPLOAD_STOPPING', '上传服务正在关闭，请稍后重试');
      waiting.splice(0).forEach(entry => entry.reject(error));
      if (active) await new Promise(done => drained.push(done));
    },
  };
}

export function createStandaloneImageUploads({ storageRoot, authorize, now = Date.now, maxBytes = 2 * 1024 ** 3 }) {
  const root = resolve(storageRoot, 'image-editor-upload-staging');
  const locks = new Map();
  const gate = createUploadGate();
  let lastSweep = -Infinity;
  let sweepFlight;
  let sweepCursor = 0;
  let admission = Promise.resolve();
  async function admit(action) {
    const previous = admission;
    let release;
    admission = new Promise(done => { release = done; });
    await previous;
    try { return await action(); } finally { release(); }
  }
  const filename = (actor, requestId, index) => `${normalizeTaskId(actor.userId)}-${normalizeUuid(requestId, 'requestId')}-${uploadIndex(index)}`;
  async function receipt(actor, requestId, index, { cleanup = false } = {}) {
    const key = filename(actor, requestId, index);
    const value = await readFile(resolve(root, `${key}.json`), 'utf8').then(JSON.parse);
    if (value.ownerId !== actor.userId || (!cleanup && value.credentialVersion !== actor.credentialVersion)
      || value.requestId !== requestId || value.index !== index || !HEX_HASH.test(value.sha256)
      || value.file !== `${key}-${value.sha256}.png` || !Number.isFinite(value.createdAt)
      || (!cleanup && now() - value.createdAt > TTL_MS)) throw new TypeError('上传图片已过期或不属于当前账号，请重新上传');
    normalizeUuid(value.token, 'upload token');
    return value;
  }
  async function storeReceipt(value, key) {
    const path = resolve(root, `${key}.json`);
    const temporary = resolve(root, `${key}-${randomUUID()}.tmp`);
    try { await writeFile(temporary, JSON.stringify(value), { flag: 'wx' }); await rename(temporary, path); }
    finally { await unlink(temporary).catch(() => {}); }
  }
  async function withRequest(actor, rawRequestId, action) {
    const requestId = normalizeUuid(rawRequestId, 'requestId');
    await authorize(actor);
    const key = `${normalizeTaskId(actor.userId)}:${requestId}`;
    const previous = locks.get(key) ?? Promise.resolve();
    let release;
    const held = new Promise(done => { release = done; });
    const queued = previous.catch(() => {}).then(() => held);
    locks.set(key, queued);
    await previous.catch(() => {});
    try { await authorize(actor); return await action(requestId); }
    finally { release(); if (locks.get(key) === queued) locks.delete(key); }
  }
  async function sweep() {
    if (sweepFlight) return sweepFlight;
    if (now() - lastSweep < 60_000) return;
    lastSweep = now();
    sweepFlight = (async () => {
      await mkdir(root, { recursive: true });
      const entries = await readdir(root, { withFileTypes: true });
      const eligible = entries.filter(item => item.isFile() && (RECEIPT_NAME.test(item.name) || DATA_NAME.test(item.name)));
      const start = sweepCursor % Math.max(1, eligible.length);
      const window = [...eligible.slice(start), ...eligible.slice(0, start)].slice(0, 1024);
      sweepCursor = start + window.length;
      for (const entry of window) {
        const match = /^([1-9]\d*)-([0-9a-f-]{36})-/u.exec(entry.name);
        if (locks.has(`${match[1]}:${match[2]}`)) continue;
        const path = resolve(root, entry.name);
        const info = await stat(path).catch(() => null);
        if (info && now() - info.mtimeMs > TTL_MS) await unlink(path).catch(() => {});
      }
    })().finally(() => { sweepFlight = null; });
    return sweepFlight;
  }
  async function finalizeEntries(entries, actor, requestId, taskId) {
    for (const value of entries) {
      const key = filename(actor, requestId, value.index);
      try { await storeReceipt({ ...value, committedTaskId: taskId }, key); }
      catch (error) {
        // The authoritative retry manifest is already committed in PostgreSQL.
        // If a receipt cannot be rewritten, remove it together with its PNG.
        await unlink(resolve(root, value.file)).catch(cause => { if (cause.code !== 'ENOENT') throw cause; });
        await unlink(resolve(root, `${key}.json`)).catch(cause => { if (cause.code !== 'ENOENT') throw cause; });
        continue;
      }
      await unlink(resolve(root, value.file)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  return {
    run: gate.run,
    dispose: gate.dispose,
    async stage(rawRequestId, rawIndex, bytes, mediaType, actor, { signal } = {}) {
      const index = uploadIndex(rawIndex);
      return withRequest(actor, rawRequestId, async requestId => {
        signal?.throwIfAborted();
        await sweep();
        const decoded = await decodeReference(bytes, mediaType);
        signal?.throwIfAborted();
        if (decoded.width !== limits.width || decoded.height !== limits.height) throw new TypeError('原图必须为 1086×1448，不会自动拉伸或裁切');
        const key = filename(actor, requestId, index);
        const prior = await receipt(actor, requestId, index).catch(error => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (prior) {
          if (prior.originalSha256 !== decoded.originalSha256) throw new ControlPlaneConflictError('UPLOAD_CONFLICT', '相同请求编号对应不同上传内容');
          return { index, token: prior.token };
        }
        const value = { ownerId: actor.userId, credentialVersion: actor.credentialVersion, requestId, index,
          token: randomUUID(), createdAt: now(), file: `${key}-${decoded.sha256}.png`,
          sha256: decoded.sha256, originalSha256: decoded.originalSha256, originalMediaType: decoded.originalMediaType,
          width: decoded.width, height: decoded.height, byteSize: decoded.bytes.length };
        await admit(async () => {
          signal?.throwIfAborted();
          const entries = await readdir(root);
          let pending = 0, totalBytes = 0;
          for (const name of entries) {
            if (name.startsWith(`${actor.userId}-`) && RECEIPT_NAME.test(name)) {
              const item = await readFile(resolve(root, name), 'utf8').then(JSON.parse).catch(() => null);
              if (item && !item.committedTaskId && entries.includes(item.file)) pending += 1;
            }
            if (DATA_NAME.test(name)) totalBytes += (await stat(resolve(root, name)).catch(() => null))?.size ?? 0;
          }
          if (pending >= 20) throw new ControlPlaneConflictError('UPLOAD_LIMIT', '未完成的上传较多，请稍后重试');
          const path = resolve(root, value.file);
          const existing = await stat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
          if (totalBytes + (existing ? 0 : decoded.bytes.length) > maxBytes) throw new ControlPlaneConflictError('UPLOAD_STORAGE_FULL', '上传临时空间不足，请稍后重试');
          try {
            if (existing) {
              if (existing.size !== decoded.bytes.length || imageHash(await readFile(path)) !== decoded.sha256) throw new ControlPlaneConflictError('UPLOAD_CONFLICT', '上传临时文件内容不一致，请重新上传');
            } else await writeFile(path, decoded.bytes, { flag: 'wx' });
            signal?.throwIfAborted();
            await storeReceipt(value, key);
          } catch (error) { if (!existing) await unlink(path).catch(() => {}); throw error; }
        });
        return { index, token: value.token };
      });
    },
    async commit(input, actor, createPrepared) {
      const manifest = normalizeUploadManifest(input.uploads);
      return withRequest(actor, input.requestId, async requestId => {
        const entries = [];
        for (const item of manifest) {
          const value = await receipt(actor, requestId, item.index).catch(error => {
            if (error.code === 'ENOENT') throw new TypeError('上传图片已过期，请重新上传');
            throw error;
          });
          if (item.token !== value.token) throw new TypeError('上传图片凭据无效');
          entries.push(value);
        }
        const result = await createPrepared(entries.map(value => ({ ...value, bytesFile: resolve(root, value.file) })),
          entries.map(value => ({ index: value.index, token: value.token, sha256: value.sha256 })));
        await finalizeEntries(entries, actor, requestId, result.id);
        return result;
      });
    },
    async finalize(input, actor, taskId) {
      normalizeTaskId(taskId);
      const manifest = normalizeUploadManifest(input.uploads);
      return withRequest(actor, input.requestId, async requestId => {
        const entries = [];
        for (const item of manifest) {
          const value = await receipt(actor, requestId, item.index, { cleanup: true }).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
          if (value && value.token === item.token) entries.push(value);
        }
        await finalizeEntries(entries, actor, requestId, taskId);
      });
    },
    async cancel(rawRequestId, actor) {
      return withRequest(actor, rawRequestId, async requestId => {
        for (let index = 1; index <= limits.maxImages; index += 1) {
          const value = await receipt(actor, requestId, index, { cleanup: true }).catch(error => {
            if (error.code === 'ENOENT') return null;
            throw error;
          });
          if (!value || value.committedTaskId) continue;
          await unlink(resolve(root, value.file)).catch(() => {});
          await unlink(resolve(root, `${filename(actor, requestId, index)}.json`)).catch(() => {});
        }
        return { cleared: true };
      });
    },
    sweep,
  };
}
