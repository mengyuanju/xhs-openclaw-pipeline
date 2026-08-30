import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';

import { normalizeProductionSettings } from './production-settings.mjs';

const CHECKPOINT_SCHEMA_VERSION = 8;
const MAX_CHECKPOINT_BYTES = 500_000;
const MAX_CHECKPOINT_IMAGE_BYTES = 25 * 1024 * 1024;

function checkpointPath(outputRoot, taskId) {
  if (!Number.isInteger(taskId) || taskId < 1) throw new TypeError('checkpoint task id is invalid');
  const root = resolve(outputRoot);
  const path = resolve(root, String(taskId), 'checkpoint.json');
  const relation = relative(root, path);
  if (!relation || relation.startsWith('..')) throw new Error('checkpoint path escaped the output root');
  return path;
}

function fingerprintPostOverride(workerConfig) {
  const postOverride = workerConfig?.postOverride ?? null;
  if (!postOverride || workerConfig?.imageCountMode !== 'auto') return postOverride;
  const { imagePlan: _discardedAutomaticPlan, ...stableOverride } = postOverride;
  return stableOverride;
}

function fingerprintInput(task, workerConfig, mock) {
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    task: {
      id: task.id,
      query: task.query,
      input: task.input ?? {},
    },
    mode: mock ? 'mock' : 'live',
    config: {
      imageCount: workerConfig?.imageCount ?? 3,
      imageCountMode: workerConfig?.imageCountMode ?? null,
      textPromptContent: workerConfig?.textPromptContent ?? null,
      imagePromptContent: workerConfig?.imagePromptContent ?? null,
      imageEditPromptContent: workerConfig?.imageEditPromptContent ?? null,
      currentTextRevisionId: workerConfig?.currentTextRevisionId ?? null,
      postOverride: fingerprintPostOverride(workerConfig),
      referenceImagePaths: workerConfig?.referenceImagePaths ?? [],
      visualReference: workerConfig?.visualReference ?? null,
      visualReferenceImagePaths: workerConfig?.visualReferenceImagePaths ?? [],
      productionSettings: normalizeProductionSettings(workerConfig?.productionSettings ?? {}),
    },
  };
}

export function createCheckpointFingerprint({ task, workerConfig, mock }) {
  if (!task || !Number.isInteger(task.id)) throw new TypeError('checkpoint task is required');
  return createHash('sha256')
    .update(JSON.stringify(fingerprintInput(task, workerConfig, mock)))
    .digest('hex');
}

export async function loadPipelineCheckpoint({ outputRoot, taskId, fingerprint }) {
  const path = checkpointPath(outputRoot, taskId);
  let content;
  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_CHECKPOINT_BYTES) return null;
  try {
    const checkpoint = JSON.parse(content);
    if (checkpoint?.schemaVersion !== CHECKPOINT_SCHEMA_VERSION
      || checkpoint.fingerprint !== fingerprint) return null;
    return checkpoint;
  } catch {
    return null;
  }
}

export async function savePipelineCheckpoint({
  outputRoot,
  taskId,
  fingerprint,
  research,
  stageReviews,
  post,
  visualPlan,
  images = [],
}) {
  const path = checkpointPath(outputRoot, taskId);
  const checkpoint = {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    fingerprint,
    research: research ?? null,
    stageReviews: stageReviews ?? null,
    post: post ?? null,
    visualPlan: visualPlan ?? null,
    images: Array.isArray(images) ? images : [],
    updatedAt: new Date().toISOString(),
  };
  const content = `${JSON.stringify(checkpoint, null, 2)}\n`;
  if (Buffer.byteLength(content, 'utf8') > MAX_CHECKPOINT_BYTES) {
    throw new RangeError('pipeline checkpoint exceeds the size limit');
  }
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx' });
  await rename(temporaryPath, path);
  return checkpoint;
}

function safeImagePath(outputRoot, taskId, rawRelativePath) {
  if (typeof rawRelativePath !== 'string' || rawRelativePath.length < 3
    || rawRelativePath.length > 1_000) return null;
  const root = resolve(outputRoot);
  const taskRoot = resolve(root, String(taskId));
  const path = resolve(root, rawRelativePath);
  const relation = relative(taskRoot, path);
  if (!relation || relation.startsWith('..')) return null;
  return path;
}

export async function createImageCheckpointRecord({
  outputRoot,
  outputDir,
  taskId,
  pageIndex,
  visualPlanSha256,
  image,
}) {
  if (!Number.isInteger(pageIndex) || pageIndex < 1 || pageIndex > 5) {
    throw new TypeError('checkpoint page index is invalid');
  }
  if (typeof image?.file !== 'string' || basename(image.file) !== image.file) {
    throw new TypeError('checkpoint image file is invalid');
  }
  if (image.alignment?.passed !== true || image.alignment?.failureClass !== 'PASS') {
    throw new TypeError('only alignment-passed images can be checkpointed');
  }
  const root = resolve(outputRoot);
  const filePath = resolve(outputDir, image.file);
  const relationToOutput = relative(resolve(outputDir), filePath);
  const relativePath = relative(root, filePath);
  if (!relationToOutput || relationToOutput.startsWith('..')
    || !relativePath || relativePath.startsWith('..')) {
    throw new Error('checkpoint image path escaped its output directory');
  }
  const metadata = await stat(filePath);
  if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_CHECKPOINT_IMAGE_BYTES) {
    throw new RangeError('checkpoint image size is invalid');
  }
  const content = await readFile(filePath);
  return {
    pageIndex,
    file: image.file,
    relativePath: relativePath.replaceAll('\\', '/'),
    sha256: createHash('sha256').update(content).digest('hex'),
    visualPlanSha256,
    provider: image.provider,
    model: image.model ?? null,
    generationAttempts: image.generationAttempts,
    alignment: image.alignment,
    prompt: image.prompt,
  };
}

export async function resolveReusableImageCheckpoints({
  outputRoot,
  taskId,
  checkpoint,
  visualPlanSha256,
  imagePlan,
}) {
  const reusable = Array.from({ length: imagePlan.length }, () => null);
  if (!Array.isArray(checkpoint?.images)) return reusable;
  for (const record of checkpoint.images) {
    const pageIndex = Number(record?.pageIndex);
    const plan = imagePlan[pageIndex - 1];
    const expectedFile = plan
      ? `${String(pageIndex).padStart(2, '0')}-${plan.kind}.png`
      : null;
    if (!plan || record.file !== expectedFile || record.visualPlanSha256 !== visualPlanSha256
      || record.alignment?.passed !== true || record.alignment?.failureClass !== 'PASS'
      || !/^[a-f0-9]{64}$/u.test(record.sha256 ?? '')) continue;
    const sourcePath = safeImagePath(outputRoot, taskId, record.relativePath);
    if (!sourcePath) continue;
    try {
      const metadata = await stat(sourcePath);
      if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_CHECKPOINT_IMAGE_BYTES) continue;
      const content = await readFile(sourcePath);
      if (createHash('sha256').update(content).digest('hex') !== record.sha256) continue;
    } catch {
      continue;
    }
    reusable[pageIndex - 1] = {
      file: record.file,
      sourcePath,
      provider: record.provider,
      model: record.model ?? null,
      generationAttempts: record.generationAttempts,
      alignment: record.alignment,
      prompt: typeof record.prompt === 'string' ? record.prompt : null,
      reusedFromCheckpoint: true,
    };
  }
  if (!reusable[0]) return Array.from({ length: imagePlan.length }, () => null);
  return reusable;
}
