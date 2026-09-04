import { createHash } from 'node:crypto';
import { appendFile, copyFile, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

import {
  DELIVERY_IMAGE_HEIGHT,
  DELIVERY_IMAGE_WIDTH,
} from './image-output-contract.mjs';
import { parseVisualPlanOutput } from './visual-plan.mjs';

const ALIGNMENT_ATTEMPTS_FILE = 'alignment-attempts.jsonl';
const IMAGE_FILE = /^\d{2}-[a-z][a-z0-9-]{0,30}\.png$/u;
const IMAGE_MAX_BYTES = 30 * 1024 * 1024;

export async function writeImageCheckpoint({ image, outputPath, completed = false, stage = 'normalized' }) {
  if (!IMAGE_FILE.test(image.file)) throw new TypeError('invalid checkpoint image file');
  const sha256 = createHash('sha256').update(await readFile(outputPath)).digest('hex');
  const path = `${outputPath}.checkpoint.json`;
  await writeFile(`${path}.tmp`, JSON.stringify({ schemaVersion: 1, sha256, image, completed, stage }), 'utf8');
  await rename(`${path}.tmp`, path);
}

async function readImageCheckpoint(path) {
  try {
    const content = await readFile(`${path}.checkpoint.json`);
    if (content.byteLength > 200_000) return null;
    const value = JSON.parse(content.toString('utf8'));
    return value.schemaVersion === 1 && isRecord(value.image) ? value : null;
  } catch {
    return null;
  }
}

export async function stageRecoveryImages({ images, outputDir }) {
  // Copy every available page before resuming work, including later parallel
  // successes, so a second failure cannot lose the previous run's checkpoints.
  for (const image of images.filter(Boolean)) {
    const rawFile = `.raw-${image.file.slice(0, 2)}-attempt-${image.generationAttempts}.png`;
    const outputPath = join(outputDir, image.needsNormalization ? rawFile : image.file);
    await copyFile(image.sourcePath, outputPath);
    const hash = createHash('sha256').update(await readFile(outputPath)).digest('hex');
    if (hash !== image.sha256) throw new StandaloneImageRecoveryError('恢复图片在复制时发生变化');
    await writeImageCheckpoint({
      image, outputPath, completed: image.completed === true,
      stage: image.needsNormalization ? 'raw' : 'normalized',
    });
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class StandaloneImageRecoveryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StandaloneImageRecoveryError';
    this.code = 'IMAGE_GENERATION_NOT_RECOVERABLE';
  }
}

export function createAlignmentAttemptRecorder({ outputDir, redact }) {
  if (typeof redact !== 'function') throw new TypeError('alignment response redactor is required');
  let writeQueue = Promise.resolve();
  return function recordInvalidAlignmentResponse({
    pageIndex,
    generationAttempt,
    responseAttempt,
    model,
    rawText,
    error,
  }) {
    const raw = String(rawText ?? '');
    const record = {
      pageIndex,
      generationAttempt,
      responseAttempt,
      model: typeof model === 'string' ? model.slice(0, 200) : null,
      parserError: redact(error),
      rawTextSha256: createHash('sha256').update(raw).digest('hex'),
      responseExcerpt: redact(raw),
      createdAt: new Date().toISOString(),
    };
    writeQueue = writeQueue.catch(() => {}).then(() => appendFile(
      join(outputDir, ALIGNMENT_ATTEMPTS_FILE),
      `${JSON.stringify(record)}\n`,
      'utf8',
    ));
    return writeQueue;
  };
}

export function recoverableAlignmentReason(diagnostic) {
  if (diagnostic?.code === 'ALIGNMENT_RESPONSE_INVALID'
    || diagnostic?.code === 'ALIGNMENT_SERVICE_FAILED') return diagnostic.code;
  if (diagnostic?.code === 'ALIGNMENT_FAILED'
    && /valid JSON object|invalid response/iu.test(diagnostic.message ?? '')) {
    return 'ALIGNMENT_RESPONSE_INVALID';
  }
  return null;
}

export function sourceForStandaloneRecovery(storedSource) {
  if (!isRecord(storedSource) || !isRecord(storedSource.post)) {
    throw new StandaloneImageRecoveryError('原运行没有可恢复的文案与图片策划');
  }
  return {
    query: storedSource.query,
    copy: {
      title: storedSource.post.title,
      body: storedSource.post.body,
      tags: storedSource.post.tags,
    },
    imagePlan: storedSource.post.imagePlan,
  };
}

export function plannedForStandaloneRecovery({ storedPlan, post, normalizeNotice }) {
  if (!isRecord(storedPlan) || !isRecord(storedPlan.value)) {
    throw new StandaloneImageRecoveryError('原运行没有可恢复的视觉规划');
  }
  let visualPlan;
  try {
    visualPlan = parseVisualPlanOutput(JSON.stringify(storedPlan.value), {
      post,
      imageCount: post.imagePlan.length,
    });
  } catch {
    throw new StandaloneImageRecoveryError('原运行的视觉规划无法通过结构校验');
  }
  return {
    visualPlan,
    model: typeof storedPlan.model === 'string' ? storedPlan.model.slice(0, 200) : null,
    degraded: storedPlan.degraded === true,
    warning: storedPlan.warning === null || storedPlan.warning === undefined
      ? null
      : normalizeNotice(storedPlan.warning, 'visualPlan.warning'),
  };
}

export async function discoverStandaloneRecoveryImages({ outputDir, post }) {
  const images = Array.from({ length: post.imagePlan.length });
  for (const [index, plan] of post.imagePlan.entries()) {
    const file = `${String(index + 1).padStart(2, '0')}-${plan.kind}.png`;
    // A pending raw image takes precedence over an older normalized repair
    // attempt. It is retained until its normalized checkpoint is durable.
    const candidates = [3, 2, 1].map((attempt) => ({
      name: `.raw-${String(index + 1).padStart(2, '0')}-attempt-${attempt}.png`, attempt,
    }));
    candidates.push({ name: file, attempt: 0 });
    for (const { name, attempt } of candidates) {
      if (images[index] && attempt) continue;
      const sourcePath = join(outputDir, name);
      try {
        const content = await readFile(sourcePath);
        if (content.byteLength < 1 || content.byteLength > IMAGE_MAX_BYTES) continue;
        const metadata = await sharp(content, {
          failOn: 'error',
          limitInputPixels: 40_000_000,
        }).metadata();
        if (metadata.format !== 'png' || (!attempt && (metadata.width !== DELIVERY_IMAGE_WIDTH
          || metadata.height !== DELIVERY_IMAGE_HEIGHT))) continue;
        const sha256 = createHash('sha256').update(content).digest('hex');
        const checkpoint = await readImageCheckpoint(sourcePath);
        if (attempt && (checkpoint?.stage !== 'raw' || checkpoint.image.generationAttempts !== attempt)) continue;
        if (checkpoint && (checkpoint.sha256 !== sha256 || checkpoint.image.file !== file)) continue;
        // A completed normalization can outlive a failed raw-file cleanup.
        if (images[index] && !(checkpoint?.image.generationAttempts >= images[index].generationAttempts)) continue;
        images[index] = {
          ...checkpoint?.image,
          file,
          sourcePath,
          sha256,
          needsNormalization: attempt > 0,
          completed: checkpoint?.completed === true,
          provider: checkpoint?.image.provider ?? 'recovered-existing-image',
          model: checkpoint?.image.model ?? null,
        };
      } catch {
        // Missing or malformed images are regenerated in the recovery run.
      }
    }
  }
  return images;
}

export async function countStandaloneGeneratedImages(outputDir, imageCount) {
  try {
    const files = await readdir(outputDir, { withFileTypes: true });
    return Math.min(
      imageCount,
      files.filter((entry) => entry.isFile() && IMAGE_FILE.test(entry.name)).length,
    );
  } catch {
    return 0;
  }
}
