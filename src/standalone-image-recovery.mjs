import { createHash } from 'node:crypto';
import { appendFile, readFile, readdir } from 'node:fs/promises';
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
    const sourcePath = join(outputDir, file);
    try {
      const content = await readFile(sourcePath);
      if (content.byteLength < 1 || content.byteLength > IMAGE_MAX_BYTES) continue;
      const metadata = await sharp(content, {
        failOn: 'error',
        limitInputPixels: 40_000_000,
      }).metadata();
      if (metadata.format !== 'png' || metadata.width !== DELIVERY_IMAGE_WIDTH
        || metadata.height !== DELIVERY_IMAGE_HEIGHT) continue;
      images[index] = {
        file,
        sourcePath,
        sha256: createHash('sha256').update(content).digest('hex'),
        provider: 'recovered-existing-image',
        model: null,
      };
    } catch {
      // Missing or malformed images are regenerated in the recovery run.
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
