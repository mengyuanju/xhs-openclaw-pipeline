import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

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
export function createAssetDelivery({ storageRoot }) {
  const pending = new Map();
  const lanes = [Promise.resolve(), Promise.resolve()];
  let nextLane = 0;

  async function thumbnail(asset, sourcePath) {
    const directory = join(storageRoot, 'thumbnails', String(asset.taskId));
    const path = join(directory, `${asset.id}-${asset.sha256}-${THUMBNAIL_VERSION}.webp`);
    const cached = await fileInfo(path);
    if (cached?.isFile() && cached.size > 0) return { path, info: cached };
    if (pending.has(path)) return pending.get(path);
    if (pending.size >= 32) throw new AssetDeliveryError(503, 'THUMBNAIL_BUSY', '预览图处理繁忙，请稍后重试');
    const lane = nextLane++ % lanes.length;
    const job = lanes[lane].then(async () => {
      await mkdir(directory, { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await sharp(sourcePath, { limitInputPixels: 40_000_000, failOn: 'error' })
          .rotate().resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 75, alphaQuality: 100 }).toFile(temporary);
        await rename(temporary, path);
        return { path, info: await stat(path) };
      } finally { await rm(temporary, { force: true }).catch(() => {}); }
    });
    pending.set(path, job);
    lanes[lane] = job.catch(() => {});
    try { return await job; } finally { pending.delete(path); }
  }

  // Caller must authorize the task before invoking this, including conditional requests.
  return async function deliverAsset(ctx, asset, sourcePath) {
    const variant = ctx.query.variant;
    if (variant !== undefined && variant !== 'thumbnail') throw new TypeError('图片预览类型无效');
    if (!Number.isSafeInteger(asset.id) || asset.id < 1 || !Number.isSafeInteger(asset.taskId) || asset.taskId < 1
      || !/^[a-f0-9]{64}$/u.test(asset.sha256)) throw new TypeError('图片资产信息无效');
    const original = await fileInfo(sourcePath);
    if (!original?.isFile()) throw new AssetDeliveryError(404, 'ASSET_FILE_MISSING', '图片文件不存在');
    const selected = variant === 'thumbnail' ? await thumbnail(asset, sourcePath) : { path: sourcePath, info: original };
    ctx.status = 200;
    ctx.type = variant === 'thumbnail' ? 'image/webp' : asset.mediaType;
    ctx.set('Cache-Control', 'private, no-cache');
    ctx.etag = `"${asset.sha256}-${variant === 'thumbnail' ? THUMBNAIL_VERSION : 'original'}"`;
    if (ctx.fresh) { ctx.status = 304; return; }
    ctx.length = selected.info.size;
    if (ctx.method !== 'HEAD') ctx.body = createReadStream(selected.path);
  };
}
