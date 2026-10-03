import { randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { lstat, open, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { derivedDirectory } from './derived-storage-paths.mjs';
import { createThumbnailCache } from './thumbnail-cache.mjs';

const THUMBNAIL_VERSION = 'thumb-480-v1';

export class AssetDeliveryError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

async function fileInfo(path) {
  try { return await stat(path); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** Fixed-size derivatives are shared on disk; only two transforms run at once per app. */
export function createAssetDelivery({ storageRoot, thumbnailCache = {} }) {
  const pending = new Map();
  const lanes = [Promise.resolve(), Promise.resolve()];
  let nextLane = 0;
  let stopping = false;
  const cache = createThumbnailCache(storageRoot, thumbnailCache);

  async function thumbnail(asset, sourcePath, directory, path) {
    const cached = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (cached?.isSymbolicLink()) throw new TypeError('预览缓存文件无效');
    if (cached?.isFile() && cached.size > 0) return { path, info: cached };
    if (pending.has(path)) return pending.get(path);
    if (pending.size >= 32) throw new AssetDeliveryError(503, 'THUMBNAIL_BUSY', '预览图处理繁忙，请稍后重试');
    const lane = nextLane++ % lanes.length;
    const job = lanes[lane].then(async () => {
      if (stopping) throw new AssetDeliveryError(503, 'THUMBNAIL_BUSY', '预览图服务正在关闭');
      const temporary = `${path}.${randomUUID()}.tmp`;
      const releaseTemporary = await cache.pin(temporary);
      try {
        await sharp(sourcePath, { limitInputPixels: 40_000_000, failOn: 'error' })
          .rotate().resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 75, alphaQuality: 100 }).toFile(temporary);
        if (!await fileInfo(sourcePath)) {
          throw new AssetDeliveryError(404, 'ASSET_FILE_MISSING', '图片文件不存在');
        }
        await rename(temporary, path);
        if (!await fileInfo(sourcePath)) {
          await rm(path, { force: true });
          throw new AssetDeliveryError(404, 'ASSET_FILE_MISSING', '图片文件不存在');
        }
        return { path, info: await stat(path) };
      } finally { await rm(temporary, { force: true }).catch(() => {}); releaseTemporary(); }
    });
    pending.set(path, job);
    lanes[lane] = job.catch(() => {});
    try { return await job; } finally { pending.delete(path); }
  }

  // Caller must authorize the task before invoking this, including conditional requests.
  const deliverAsset = async function deliverAsset(ctx, asset, sourcePath) {
    const variant = ctx.query.variant;
    if (variant !== undefined && variant !== 'thumbnail') throw new TypeError('图片预览类型无效');
    if (!Number.isSafeInteger(asset.id) || asset.id < 1 || !Number.isSafeInteger(asset.taskId) || asset.taskId < 1
      || !/^[a-f0-9]{64}$/u.test(asset.sha256)) throw new TypeError('图片资产信息无效');
    const original = await fileInfo(sourcePath);
    if (!original?.isFile()) throw new AssetDeliveryError(404, 'ASSET_FILE_MISSING', '图片文件不存在');
    // The representation is identified by the immutable original and transform
    // version. Authorized conditional reads need no derivative on disk.
    ctx.status = 200;
    ctx.type = variant === 'thumbnail' ? 'image/webp' : asset.mediaType;
    ctx.set('Cache-Control', 'private, no-cache');
    ctx.etag = `"${asset.sha256}-${variant === 'thumbnail' ? THUMBNAIL_VERSION : 'original'}"`;
    if (ctx.fresh) { ctx.status = 304; return; }
    let release, handle;
    try {
      let selected = { path: sourcePath, info: original };
      if (variant === 'thumbnail') {
        const root = await derivedDirectory(storageRoot, 'thumbnails');
        const directory = await derivedDirectory(root, String(asset.taskId));
        const path = join(directory, `${asset.id}-${asset.sha256}-${THUMBNAIL_VERSION}.webp`);
        release = await cache.pin(path);
        selected = await thumbnail(asset, sourcePath, directory, path);
        cache.remember(path, selected.info, true); cache.kick();
      }
      ctx.length = selected.info.size;
      if (ctx.method !== 'HEAD') {
        if (variant === 'thumbnail') {
          // Fix the inode before returning. Own sweeps cannot unlink pinned
          // reads; other processes cannot make an opened read lose its bytes.
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
              const metadata = await lstat(selected.path);
              if (metadata.isSymbolicLink() || !metadata.isFile()) throw new TypeError('预览缓存文件无效');
              handle = await open(selected.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
              const opened = await handle.stat();
              if (!opened.isFile() || opened.ino !== metadata.ino || opened.dev !== metadata.dev) {
                await handle.close(); handle = null; throw new TypeError('预览缓存文件已改变');
              }
              break;
            }
            catch (error) {
              if (error.code !== 'ENOENT' || attempt === 2) throw error;
              const directory = await derivedDirectory(await derivedDirectory(storageRoot, 'thumbnails'), String(asset.taskId));
              selected = await thumbnail(asset, sourcePath, directory, selected.path);
              cache.remember(selected.path, selected.info, true); ctx.length = selected.info.size;
            }
          }
          const stream = handle.createReadStream(); handle = null;
          const releaseRead = release; release = null;
          stream.once('close', releaseRead); ctx.body = stream;
        } else ctx.body = createReadStream(selected.path);
      }
    } finally { await handle?.close(); release?.(); }
  };
  deliverAsset.sweep = () => cache.sweep();
  deliverAsset.dispose = async () => { stopping = true; await Promise.all(lanes); await cache.dispose(); };
  return deliverAsset;
}
