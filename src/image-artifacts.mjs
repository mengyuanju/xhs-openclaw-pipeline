import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import sharp from 'sharp';
import { IMAGE_FORMATS, normalizeImageSettings } from '../server/src/image-options.mjs';

export const IMAGE_ARTIFACT_FILE = /^(?:source-)?\d{2}-[a-z][a-z0-9-]{0,30}\.(?:png|jpg|webp|avif|gif)$/u;

// Encode once, then decode the actual delivery bytes for browser preview and QC.
// Source is the normalized full artwork before flattening, so a later revision can undo a fill.
export async function prepareImageArtifacts({ source, outputDir, file, settings, deliveryOverlaySvg = null }) {
  if (!/^\d{2}-[a-z][a-z0-9-]{0,30}\.png$/u.test(file)) throw new TypeError('invalid image artifact file');
  if (deliveryOverlaySvg !== null
    && (typeof deliveryOverlaySvg !== 'string' || Buffer.byteLength(deliveryOverlaySvg, 'utf8') > 100_000)) {
    throw new TypeError('delivery overlay SVG is invalid');
  }
  const resolved = normalizeImageSettings(settings);
  const codec = IMAGE_FORMATS[resolved.format];
  const sourceFile = `source-${file}`;
  const deliveryFile = file.replace(/\.png$/u, `.${codec.extension}`);
  const original = await sharp(source, { limitInputPixels: 40_000_000, failOn: 'error' }).png().toBuffer();
  const sourceTransparent = !(await sharp(original).stats()).isOpaque;
  const rendered = deliveryOverlaySvg === null ? original : await sharp(original)
    .composite([{ input: Buffer.from(deliveryOverlaySvg, 'utf8'), top: 0, left: 0 }])
    .png({ compressionLevel: 8 })
    .toBuffer();
  let encoder = sharp(rendered);
  if (resolved.background === 'SOLID') encoder = encoder.flatten({ background: resolved.backgroundColor });
  const options = resolved.format === 'PNG' ? { compressionLevel: 8 }
    : resolved.format === 'GIF' ? {} : { quality: resolved.quality };
  const delivery = await encoder.toFormat(resolved.format.toLowerCase(), options).toBuffer();
  const preview = resolved.format === 'PNG' ? delivery : await sharp(delivery).png().toBuffer();
  await writeFile(join(outputDir, sourceFile), original);
  await writeFile(join(outputDir, deliveryFile), delivery);
  if (deliveryFile !== file) await writeFile(join(outputDir, file), preview);
  return {
    file, sourceFile, deliveryFile, mediaType: codec.mediaType, imageSettings: resolved,
    transparency: { source: sourceTransparent, delivery: !(await sharp(delivery).stats()).isOpaque },
    artifactHashes: Object.fromEntries([[sourceFile, original], [deliveryFile, delivery], [file, preview]]
      .map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')])),
  };
}

export async function copyImageArtifacts(image, sourceDir, outputDir) {
  if (!image.imageSettings) return {};
  normalizeImageSettings(image.imageSettings);
  for (const name of [image.sourceFile, image.deliveryFile]) {
    if (!IMAGE_ARTIFACT_FILE.test(name ?? '') || !image.artifactHashes?.[name]) throw new TypeError('image artifact checkpoint is incomplete');
    const bytes = await readFile(join(sourceDir, name));
    if (createHash('sha256').update(bytes).digest('hex') !== image.artifactHashes[name]) throw new TypeError('image artifact checkpoint changed');
    if (sourceDir !== outputDir) await writeFile(join(outputDir, name), bytes);
  }
  return Object.fromEntries(['sourceFile', 'deliveryFile', 'mediaType', 'imageSettings', 'transparency', 'artifactHashes'].map(key => [key, image[key]]));
}

export function publicImageArtifacts(image) {
  if (!image.imageSettings) return {};
  const settings = normalizeImageSettings(image.imageSettings);
  for (const name of [image.sourceFile, image.deliveryFile]) if (!IMAGE_ARTIFACT_FILE.test(name ?? '')) throw new TypeError('invalid image artifact');
  return { imageSettings: settings, sourceFile: image.sourceFile, deliveryFile: image.deliveryFile,
    sourceOriginal: image.sourceOriginal !== false,
    mediaType: IMAGE_FORMATS[settings.format].mediaType,
    transparency: { source: image.transparency?.source === true, delivery: image.transparency?.delivery === true } };
}
