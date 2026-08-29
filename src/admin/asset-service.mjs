import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import sharp from 'sharp';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 40_000_000;
const MIME_TO_FORMAT = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpeg'],
  ['image/webp', 'webp'],
]);

function safeAbsolute(root, child) {
  const rootPath = resolve(root);
  const outputPath = resolve(rootPath, child);
  const relation = relative(rootPath, outputPath);
  if (!relation || relation.startsWith('..') || relation.includes(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error('asset path escaped the upload root');
  }
  return outputPath;
}

async function decodedMetadata(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer) || buffer.byteLength === 0) throw new TypeError('image upload cannot be empty');
  if (buffer.byteLength > MAX_IMAGE_BYTES) throw new RangeError('image upload cannot exceed 10 MiB');
  const expectedFormat = MIME_TO_FORMAT.get(mimeType);
  if (!expectedFormat) throw new TypeError('image MIME type is not allowed');
  let metadata;
  try {
    metadata = await sharp(buffer, { failOn: 'error', limitInputPixels: MAX_IMAGE_PIXELS }).metadata();
  } catch {
    throw new TypeError('image upload could not be decoded');
  }
  if (metadata.format !== expectedFormat) throw new TypeError('image content does not match its MIME type');
  if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_IMAGE_PIXELS) {
    throw new RangeError('image dimensions are not allowed');
  }
  return metadata;
}

async function finalizePng({ pipeline, outputPath }) {
  const temporaryPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(dirname(outputPath), { recursive: true });
  try {
    await pipeline.png({ compressionLevel: 8 }).toFile(temporaryPath);
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
  const content = await readFile(outputPath);
  const metadata = await sharp(content, { limitInputPixels: MAX_IMAGE_PIXELS }).metadata();
  return {
    content,
    width: metadata.width,
    height: metadata.height,
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}

export async function saveUploadedImage({
  store,
  taskId,
  buffer,
  fileName: _originalFileName,
  mimeType,
  uploadRoot,
}) {
  if (!store?.getTask(taskId)) throw new Error('task not found');
  await decodedMetadata(buffer, mimeType);
  const safeFileName = `reference-${randomUUID()}.png`;
  const relativePath = `references/${Number(taskId)}/${safeFileName}`;
  const absolutePath = safeAbsolute(uploadRoot, relativePath);
  const output = await finalizePng({
    pipeline: sharp(buffer, { failOn: 'error', limitInputPixels: MAX_IMAGE_PIXELS }).rotate(),
    outputPath: absolutePath,
  });
  const asset = store.addAsset({
    taskId,
    kind: 'REFERENCE',
    parentAssetId: null,
    fileName: safeFileName,
    relativePath,
    mimeType: 'image/png',
    width: output.width,
    height: output.height,
    sha256: output.sha256,
    source: 'upload',
  });
  return { ...asset, absolutePath };
}

function revisionPipeline(inputPath, operation) {
  const pipeline = sharp(inputPath, { failOn: 'error', limitInputPixels: MAX_IMAGE_PIXELS });
  if (operation?.type === 'rotate') {
    if (![90, 180, 270].includes(operation.degrees)) throw new TypeError('rotation must be 90, 180 or 270 degrees');
    return pipeline.rotate(operation.degrees);
  }
  if (operation?.type === 'crop-3x4') {
    return pipeline.resize(1080, 1440, { fit: 'cover', position: 'attention' });
  }
  throw new TypeError('image revision operation is invalid');
}

export async function createImageRevision({ store, taskId, assetId, operation, uploadRoot }) {
  const parent = store?.getAsset(assetId);
  if (!parent || parent.taskId !== Number(taskId)) throw new Error('asset not found for task');
  const inputPath = safeAbsolute(uploadRoot, parent.relativePath);
  const safeFileName = `revision-${randomUUID()}.png`;
  const relativePath = `revisions/${Number(taskId)}/${safeFileName}`;
  const absolutePath = safeAbsolute(uploadRoot, relativePath);
  const output = await finalizePng({
    pipeline: revisionPipeline(inputPath, operation),
    outputPath: absolutePath,
  });
  const asset = store.addAsset({
    taskId,
    kind: 'EDITED',
    parentAssetId: parent.id,
    fileName: safeFileName,
    relativePath,
    mimeType: 'image/png',
    width: output.width,
    height: output.height,
    sha256: output.sha256,
    source: `manual:${operation.type}`,
    sourceTextRevisionId: parent.sourceTextRevisionId,
    pageIndex: parent.pageIndex,
    visualPlanSha256: parent.visualPlanSha256,
    alignmentStatus: parent.sourceTextRevisionId ? 'MANUAL_REQUIRED' : 'UNVERIFIED',
    alignmentResult: {
      parentAlignmentStatus: parent.alignmentStatus,
      reason: 'manual image revision requires renewed visual review',
    },
  });
  return { ...asset, absolutePath };
}

export { MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS };
