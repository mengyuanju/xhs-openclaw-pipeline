import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { open, rm } from 'node:fs/promises';
import sharp from 'sharp';

export const CODEX_NATIVE_IMAGE_MAX_INPUTS = 5;
// Application transport budget, not an advertised Codex model limit. Keep the
// base64 file-reader response below the affected Windows relay's 2 MiB buffer.
export const CODEX_NATIVE_IMAGE_MAX_BYTES = 1024 * 1024;

async function nativeImage(path) {
  const original = await sharp(path, { failOn: 'error', limitInputPixels: 40_000_000 })
    .rotate().png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true });
  let data = original.data, info = original.info;
  const alpha = [2, 4].includes(info.channels);
  const encode = pipeline => alpha ? pipeline.png({ compressionLevel: 9 })
    : pipeline.jpeg({ quality: 95, chromaSubsampling: '4:4:4' });
  // High-quality JPEG preserves full-size text on opaque photographic PNGs
  // before reducing resolution. Transparent images must remain PNG.
  if (data.length > CODEX_NATIVE_IMAGE_MAX_BYTES && !alpha) {
    ({ data, info } = await encode(sharp(original.data)).toBuffer({ resolveWithObject: true }));
  }
  let width = info.width, height = info.height;
  for (let attempt = 0; data.length > CODEX_NATIVE_IMAGE_MAX_BYTES && attempt < 4; attempt++) {
    const scale = Math.min(0.85, Math.sqrt(CODEX_NATIVE_IMAGE_MAX_BYTES / data.length) * 0.95);
    width = Math.max(1, Math.floor(width * scale));
    height = Math.max(1, Math.floor(height * scale));
    // Always resize the oriented original to avoid accumulating blur. Keep
    // transparency and the full frame; only the temporary model copy changes.
    ({ data, info } = await encode(sharp(original.data)
      .resize({ width, height, fit: 'inside', withoutEnlargement: true }))
      .toBuffer({ resolveWithObject: true }));
  }
  if (data.length > CODEX_NATIVE_IMAGE_MAX_BYTES) throw new RangeError('图片附件处理后仍超过 1 MiB，请缩小图片分辨率后重试');
  return { data, info, originalByteSize: original.data.length,
    originalWidth: original.info.width, originalHeight: original.info.height };
}

export async function prepareCodexImageInputs(inputPaths, directory, { preview = true } = {}) {
  if (!Array.isArray(inputPaths) || inputPaths.length < 1 || inputPaths.length > CODEX_NATIVE_IMAGE_MAX_INPUTS) {
    throw new RangeError(`requires 1-${CODEX_NATIVE_IMAGE_MAX_INPUTS} input images`);
  }
  const created = new Set();
  const results = await Promise.allSettled(inputPaths.map(async (path, index) => {
    if (typeof path !== 'string' || !path || path.length > 1000) throw new TypeError('input image path is invalid');
    let image;
    if (preview) {
      const { data, info } = await sharp(path, { failOn: 'error', limitInputPixels: 40_000_000 }).rotate()
        .resize({ width: 900, height: 1200, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toBuffer({ resolveWithObject: true });
      image = { data, info };
    } else image = await nativeImage(path);
    const extension = image.info.format === 'jpeg' ? 'jpg' : 'png';
    const target = join(directory, `input-${index + 1}.${extension}`);
    const file = await open(target, 'wx');
    created.add(target);
    try { await file.writeFile(image.data); } finally { await file.close(); }
    return { index: index + 1, path: target, format: image.info.format, width: image.info.width, height: image.info.height,
      byteSize: image.data.length, sha256: createHash('sha256').update(image.data).digest('hex'),
      ...(preview ? {} : { originalByteSize: image.originalByteSize,
        originalWidth: image.originalWidth, originalHeight: image.originalHeight,
        resized: image.info.width !== image.originalWidth || image.info.height !== image.originalHeight }) };
  }));
  const failure = results.find(result => result.status === 'rejected');
  if (failure) {
    // Every conversion must settle before cleanup, including delayed writers.
    await Promise.all([...created].map(path => rm(path, { force: true }).catch(() => {})));
    throw failure.reason;
  }
  const diagnostics = results.map(result => result.value);
  return { paths: diagnostics.map(image => image.path), diagnostics };
}
