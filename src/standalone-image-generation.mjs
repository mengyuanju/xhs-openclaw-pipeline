import { buildGovernedImageTaskPrompt, preserveImageSystemPrompt } from './image-prompt.mjs';
import { withPromptRuntime, promptRuntimeSnapshot, createPromptRuntime } from './prompt-runtime.mjs';
import { prepareImageArtifacts, publicImageArtifacts, IMAGE_ARTIFACT_FILE } from './image-artifacts.mjs';
import { normalizeImageSettings } from '../server/src/image-options.mjs';
import { assignRandomLayouts } from './image-layout-controls.mjs';
import { planningMetadata } from '../server/src/planning-catalog.mjs';
import { randomUUID } from 'node:crypto';
import { codexErrorCode } from './codex-protocol.mjs';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

import { composeVisualImagePrompt } from './admin/visual-knowledge-store.mjs';
import { renderPrompt } from './admin/prompt-service.mjs';
import {
  ImageAlignmentResponseError,
  ImageAlignmentServiceError,
  createImageAlignmentValidator,
} from './image-alignment.mjs';
import { renderDeliveryImages } from './images.mjs';
import { parsePostOutput } from './post-contract.mjs';
import {
  normalizeProductionSettings,
  productionDisclosure,
} from './production-settings.mjs';
import { evaluateDelivery } from './qc.mjs';
import { createDeliveryQualityAssessor, parseDeliveryQualityAssessmentOutput } from './quality-assessment.mjs';
import { generateVisualPlan } from './visual-plan-generation.mjs';
import { effectiveModelApiConfig } from './model-api-config.mjs';
import { createImageStageTimer, imageTimingProfile, readImageTimingSamples, recordImageTimingSample } from './image-stage-timing.mjs';
import {
  StandaloneImageRecoveryError,
  countStandaloneGeneratedImages,
  createAlignmentAttemptRecorder,
  discoverStandaloneRecoveryImages,
  plannedForStandaloneRecovery,
  recoverableAlignmentReason,
  sourceForStandaloneRecovery,
  stageRecoveryImages,
  writeImageCheckpoint,
} from './standalone-image-recovery.mjs';

export { StandaloneImageRecoveryError } from './standalone-image-recovery.mjs';
export { runDirectory as standaloneImageRunDirectory };

const RUN_DIRECTORY = 'standalone-image-generations';
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const IMAGE_FILE = /^\d{2}-[a-z][a-z0-9-]{0,30}\.png$/u;
const MANIFEST_MAX_BYTES = 200_000;
const IMAGE_MAX_BYTES = 30 * 1024 * 1024;
const FAILURE_DETAIL_MAX_LENGTH = 400;
const PROGRESS_FILE = 'progress.json';
const PROGRESS_STAGES = new Set([
  'PREPARING',
  'PLANNING',
  'GENERATING',
  'ALIGNING',
  'QUALITY_CHECK',
  'FINALIZING',
  'COMPLETED',
  'CANCELLED',
  'FAILED',
]);
const LEGACY_BACKGROUND_ONLY_MARKER = '整套图片均由图像模型逐张生成视觉底图';
const ONE_PASS_IMAGE_MARKER = '整套图片由图像模型一次性完成场景与文字排版';
const FAILURE_STAGE_LABELS = {
  PREPARING: '准备阶段',
  PLANNING: '视觉规划',
  GENERATING: '图片生成',
  ALIGNING: '图文对齐',
  QUALITY_CHECK: '质量检查',
  FINALIZING: '结果保存',
};
const TRANSIENT_MODEL_FAILURE = /(?:UND_ERR_SOCKET|terminated|socket hang up|fetch failed|network|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|timeout|timed out|no text output returned)/iu;
const AUTHORIZATION_FAILURE = /(?:\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid api[_ -]?key|authentication failed|permission denied)/iu;

export class StandaloneImageConfirmationError extends Error {
  constructor(message = 'Live image generation requires explicit cost confirmation') {
    super(message);
    this.name = 'StandaloneImageConfirmationError';
  }
}

export class StandaloneImageCancellationError extends Error {
  constructor(message = '图片生成已取消', options = {}) {
    super(message, { cause: options.cause });
    this.name = 'StandaloneImageCancellationError';
    this.stage = 'CANCELLED';
    this.code = 'IMAGE_GENERATION_CANCELLED';
  }
}

export class StandaloneImageAlignmentError extends Error {
  constructor(message = '图片 OCR 与图文对齐验收失败', options = {}) {
    super(message, { cause: options.cause });
    this.name = 'StandaloneImageAlignmentError';
    this.stage = 'ALIGNING';
    this.code = typeof options.code === 'string' ? options.code : 'ALIGNMENT_FAILED';
    this.retryable = options.retryable === true;
    this.detail = sanitizedFailureDetail(options.cause ?? message);
  }
}

export class StandaloneImageGenerationError extends Error {
  constructor(message, options = {}) {
    const stage = PROGRESS_STAGES.has(options.stage) && options.stage !== 'FAILED'
      ? options.stage
      : 'GENERATING';
    const detail = sanitizedFailureDetail(options.cause ?? message);
    const safeMessage = message === undefined
      ? `${FAILURE_STAGE_LABELS[stage] ?? '图片生成'}失败：${detail || '未知错误，请稍后重试'}`
      : sanitizedFailureDetail(message);
    super(safeMessage, { cause: options.cause });
    this.name = 'StandaloneImageGenerationError';
    this.stage = stage;
    this.code = typeof options.code === 'string' ? options.code : `${stage}_FAILED`;
    this.detail = detail;
  }
}

function errorChainText(error) {
  const messages = [];
  const visited = new Set();
  let current = error;
  while (current !== undefined && current !== null && messages.length < 4 && !visited.has(current)) {
    if (typeof current === 'object') visited.add(current);
    const message = current instanceof Error ? current.message : String(current);
    if (message.trim() && !messages.includes(message.trim())) messages.push(message.trim());
    current = current instanceof Error ? current.cause : undefined;
  }
  return messages.join('：');
}

function sanitizedFailureDetail(error) {
  return errorChainText(error)
    .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/giu, '[REDACTED]')
    .replace(/\b(api[_-]?key|token|authorization)\b\s*[:=]\s*[^\s,;]+/giu, '$1=[REDACTED]')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, FAILURE_DETAIL_MAX_LENGTH);
}

function isTransientModelFailure(error) {
  if (codexErrorCode(error)) return false;
  const detail = errorChainText(error);
  return !AUTHORIZATION_FAILURE.test(detail) && TRANSIENT_MODEL_FAILURE.test(detail);
}

function boundedText(value, field, minimum, maximum) {
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`);
  const text = value.trim();
  const length = [...text].length;
  if (length < minimum || length > maximum) {
    throw new RangeError(`${field} must contain between ${minimum} and ${maximum} characters`);
  }
  return text;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizedOperationalNotice(value, field) {
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || !PROGRESS_STAGES.has(value.stage)
    || typeof value.code !== 'string' || !/^[A-Z][A-Z0-9_]{1,63}$/u.test(value.code)) {
    throw new TypeError(`${field} is invalid`);
  }
  return {
    stage: value.stage,
    code: value.code,
    message: boundedText(value.message, `${field}.message`, 1, 500),
  };
}

function failureDiagnostic(error, fallbackStage) {
  const stage = PROGRESS_STAGES.has(error?.stage) && error.stage !== 'FAILED'
    ? error.stage
    : fallbackStage;
  return {
    stage,
    code: typeof error?.code === 'string' ? error.code : `${stage}_FAILED`,
    message: sanitizedFailureDetail(error?.detail || error?.cause || error) || '未知错误',
  };
}

function validatedRunId(value) {
  const runId = String(value ?? '').toLowerCase();
  if (!RUN_ID.test(runId)) throw new TypeError('standalone image run id is invalid');
  return runId;
}

function validatedImageFile(value) {
  const file = String(value ?? '');
  if (!IMAGE_FILE.test(file)) throw new TypeError('standalone image file name is invalid');
  return file;
}

function cancellationError(signal) {
  return signal?.reason instanceof StandaloneImageCancellationError
    ? signal.reason
    : new StandaloneImageCancellationError(undefined, { cause: signal?.reason });
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw cancellationError(signal);
}

function clientWithCancellation(client, signal) {
  if (!signal) return client;
  const withSignal = (method) => (input) => {
    throwIfCancelled(signal);
    return method.call(client, { ...input, signal });
  };
  return {
    ...client,
    runText: withSignal(client.runText),
    runVision: withSignal(client.runVision),
    runImage: withSignal(client.runImage),
    runImageEdit: withSignal(client.runImageEdit),
  };
}

function runDirectory(outputRoot, runId) {
  const root = resolve(outputRoot, RUN_DIRECTORY);
  const path = resolve(root, validatedRunId(runId));
  const relation = relative(root, path);
  if (!relation || relation.startsWith('..')) {
    throw new Error('standalone image run path escaped the output root');
  }
  return path;
}

async function writeJsonAtomic(path, value) {
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  await rename(temporaryPath, path);
}

export function estimateStandaloneImageDuration({ mode, imageCount, concurrency = 2, thinking = 'low' }) {
  if (mode !== 'LIVE') throw new TypeError('mode must be LIVE');
  if (!Number.isInteger(imageCount) || imageCount < 3 || imageCount > 5) {
    throw new RangeError('imageCount must be an integer between 3 and 5');
  }
  return createImageStageTimer({ imageCount, concurrency, thinking }).update('PREPARING', 0).estimatedTotalMs;
}

function createProgressReporter({ outputDir, runId, mode, imageCount, onProgress, signal, timing }) {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  let lastPercent = 0;
  let completedImages = 0;
  let generatedImages = 0;
  let validatedImages = 0;
  const timer = createImageStageTimer({ imageCount, ...timing,
    samples: readImageTimingSamples(timing) });
  const warnings = [];
  let diagnostic = null;
  let writeQueue = Promise.resolve();

  return function reportProgress(update) {
    writeQueue = writeQueue.catch((error) => {
      // A replaced execution cannot regain its lease on a later progress
      // update, including updates already queued by another parallel page.
      if (error?.code === 'STALE_EXECUTION') throw error;
    }).then(async () => {
      if (signal?.aborted && update.stage !== 'CANCELLED') throw cancellationError(signal);
      const now = Date.now();
      const elapsedMs = Math.max(0, now - startedAtMs);
      const progressPercent = Math.max(
        lastPercent,
        Math.min(100, Math.round(Number(update.progressPercent) || 0)),
      );
      lastPercent = progressPercent;
      completedImages = Math.max(
        completedImages,
        Math.min(imageCount, Math.round(Number(update.completedImages) || 0)),
      );
      generatedImages = Math.max(
        generatedImages,
        Math.min(imageCount, Math.round(Number(update.generatedImages) || 0)),
      );
      validatedImages = Math.max(
        validatedImages,
        completedImages,
        Math.min(imageCount, Math.round(Number(update.validatedImages) || 0)),
      );
      generatedImages = Math.max(generatedImages, validatedImages);
      const estimate = timer.update(update.stage, elapsedMs);
      const warning = normalizedOperationalNotice(update.warning, 'progress.warning');
      if (warning && !warnings.some((item) => item.code === warning.code
        && item.message === warning.message)) {
        warnings.push(warning);
      }
      const nextDiagnostic = normalizedOperationalNotice(
        update.diagnostic,
        'progress.diagnostic',
      );
      if (nextDiagnostic) diagnostic = nextDiagnostic;
      const terminal = ['COMPLETED', 'CANCELLED', 'FAILED'].includes(update.stage);
      const snapshot = {
        runId,
        mode,
        status: update.stage === 'COMPLETED'
          ? 'COMPLETED'
          : update.stage === 'CANCELLED'
            ? 'CANCELLED'
            : update.stage === 'FAILED' ? 'FAILED' : 'RUNNING',
        stage: update.stage,
        progressPercent,
        message: String(update.message ?? '').slice(0, 500),
        completedImages,
        generatedImages,
        validatedImages,
        totalImages: imageCount,
        currentPage: Number.isInteger(update.currentPage) ? update.currentPage : null,
        attempt: Number.isInteger(update.attempt) ? update.attempt : null,
        startedAt,
        updatedAt: new Date(now).toISOString(),
        finishedAt: terminal ? new Date(now).toISOString() : null,
        ...estimate,
        elapsedMs,
        warnings: [...warnings],
        diagnostic,
        canResume: update.canResume === true,
        retryReason: typeof update.retryReason === 'string' ? update.retryReason : null,
        error: typeof update.error === 'string' ? update.error.slice(0, 500) : null,
        result: update.result ?? null,
      };
      await writeJsonAtomic(join(outputDir, PROGRESS_FILE), snapshot);
      if (update.stage === 'COMPLETED' && timing.recordSample) recordImageTimingSample({
        ...timing, runId, stages: estimate.stageDurationsMs,
      });
      if (typeof onProgress === 'function') {
        await Promise.resolve(onProgress(snapshot)).catch((error) => {
          if (error?.code === 'STALE_EXECUTION') throw error;
        });
      }
      return snapshot;
    });
    return writeQueue;
  };
}

function normalizedStoredResult(value, runId) {
  if (!isRecord(value) || value.runId !== runId || !['MOCK', 'LIVE'].includes(value.mode)
    || !['COMPLETED', 'BLOCKED'].includes(value.status) || !Array.isArray(value.images)
    || value.images.length < 3 || value.images.length > 5 || !isRecord(value.qc)) {
    throw new TypeError('standalone image result is invalid');
  }
  const images = value.images.map((image, index) => {
    if (!isRecord(image) || image.pageIndex !== index + 1) {
      throw new TypeError('standalone image result page is invalid');
    }
    const file = validatedImageFile(image.file);
    return {
      pageIndex: index + 1,
      kind: file.replace(/^\d{2}-/u, '').replace(/\.png$/u, ''),
      file,
      url: `/api/image-generations/${runId}/images/${file}`,
      ...publicImageArtifacts(image, runId),
      provider: boundedText(image.provider, `images[${index}].provider`, 1, 100),
      model: image.model === null ? null : boundedText(image.model, `images[${index}].model`, 1, 200),
      generationAttempts: Number.isInteger(image.generationAttempts) ? image.generationAttempts : null,
      alignmentPassed: typeof image.alignmentPassed === 'boolean' ? image.alignmentPassed : null,
      layout: image.layout === null || image.layout === undefined
        ? null
        : publicLayout(image.layout, `images[${index}].layout`),
    };
  });
  const storedVisualPlan = isRecord(value.visualPlan) ? value.visualPlan : null;
  const storedQc = value.qc;
  return {
    runId,
    mode: value.mode,
    status: value.status,
    imageCount: images.length,
    images,
    ...(value.imageSettings ? { imageSettings: normalizeImageSettings(value.imageSettings) } : {}),
    ...(value.imageControlsVersion === 1 ? { imageControlsVersion: 1 } : {}),
    ...(Array.isArray(value.imagePlan) ? { imagePlan: value.imagePlan } : {}),
    ...(value.processing?.type === 'LOCAL' ? { processing: { type: 'LOCAL', sourceRunId: validatedRunId(value.processing.sourceRunId), originalAvailable: value.processing.originalAvailable === true } } : {}),
    visualPlan: storedVisualPlan === null ? null : {
      model: storedVisualPlan.model === null
        ? null
        : boundedText(storedVisualPlan.model, 'visualPlan.model', 1, 200),
      degraded: storedVisualPlan.degraded === true,
      warning: normalizedOperationalNotice(storedVisualPlan.warning, 'visualPlan.warning'),
    },
    qc: {
      passed: storedQc.passed === true,
      overallScore: Number.isFinite(storedQc.overallScore) ? Number(storedQc.overallScore) : null,
      summary: boundedText(storedQc.summary, 'qc.summary', 1, 500),
      disposition: typeof storedQc.disposition === 'string'
        ? boundedText(storedQc.disposition, 'qc.disposition', 1, 100)
        : value.mode === 'MOCK' ? 'mock_only' : value.status === 'BLOCKED' ? 'blocked' : 'manual_review_required',
      action: storedQc.action === null || storedQc.action === undefined
        ? null
        : boundedText(storedQc.action, 'qc.action', 1, 100),
      issues: publicQualityIssues(storedQc.issues),
      dimensions: publicStoredQualityDimensions(storedQc.dimensions),
      limitations: publicTextList(storedQc.limitations, 'qc.limitations', {
        minimum: 0,
        maximum: 10,
        itemMaximum: 500,
      }),
    },
  };
}

async function readOptionalRunArtifact(outputDir, file) {
  try {
    const content = await readFile(join(outputDir, file));
    if (content.byteLength > MANIFEST_MAX_BYTES) return null;
    const value = JSON.parse(content.toString('utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

async function readExecutionArtifact(outputDir, file, { optional = false, nullable = false } = {}) {
  let content;
  try { content = await readFile(join(outputDir, file)); }
  catch (error) {
    if (error.code === 'ENOENT' && optional) return null;
    throw new StandaloneImageRecoveryError(`原执行快照 ${file} 无法读取；未采用当前配置`);
  }
  // Includes JSON escaping overhead for 19 templates of 20000 bytes each.
  if (content.byteLength > 4_000_000) throw new StandaloneImageRecoveryError(`原执行快照 ${file} 超过 4000000 字节；未截断或采用当前配置`);
  let value;
  try { value = JSON.parse(content.toString('utf8')); }
  catch { throw new StandaloneImageRecoveryError(`原执行快照 ${file} JSON 损坏；未采用当前配置`); }
  if (!(nullable && value === null) && !isRecord(value)) throw new StandaloneImageRecoveryError(`原执行快照 ${file} 格式无效`);
  return value;
}

async function enrichStoredResult(outputDir, result) {
  const needsVisualPlan = result.visualPlan === null
    || result.images.some((image) => image.layout === null);
  const needsQualityDetails = result.qc.dimensions.length === 0
    || result.qc.limitations.length === 0;
  if (!needsVisualPlan && !needsQualityDetails) return result;

  const [visualPlanArtifact, qcArtifact] = await Promise.all([
    needsVisualPlan ? readOptionalRunArtifact(outputDir, 'visual-plan.json') : null,
    needsQualityDetails ? readOptionalRunArtifact(outputDir, 'qc.json') : null,
  ]);
  let visualPlan = result.visualPlan;
  let images = result.images;
  if (visualPlanArtifact) {
    try {
      if (visualPlan === null) {
        visualPlan = {
          model: visualPlanArtifact.model === null
            ? null
            : boundedText(visualPlanArtifact.model, 'visualPlan.model', 1, 200),
          degraded: visualPlanArtifact.degraded === true,
          warning: normalizedOperationalNotice(visualPlanArtifact.warning, 'visualPlan.warning'),
        };
      }
      const pages = isRecord(visualPlanArtifact.value) && Array.isArray(visualPlanArtifact.value.pages)
        ? visualPlanArtifact.value.pages
        : [];
      images = images.map((image, index) => ({
        ...image,
        layout: image.layout ?? (pages[index]
          ? publicLayout(pages[index], `visualPlan.pages[${index}]`)
          : null),
      }));
    } catch {
      visualPlan = result.visualPlan;
      images = result.images;
    }
  }

  let qc = result.qc;
  if (qcArtifact) {
    try {
      qc = { ...qc, ...publicQualityDetails(qcArtifact) };
    } catch {
      qc = result.qc;
    }
  }
  return { ...result, images, visualPlan, qc };
}

function normalizedTags(value) {
  if (!Array.isArray(value)) throw new TypeError('copy.tags must be an array');
  return value.map((tag, index) => boundedText(tag, `copy.tags[${index}]`, 2, 20));
}

export function normalizeStandaloneImageSource(source) {
  if (!isRecord(source) || !isRecord(source.copy)) {
    throw new TypeError('standalone image source and copy must be objects');
  }
  boundedText(source.query, 'query', 1, 500);
  if (!Array.isArray(source.imagePlan) || source.imagePlan.length < 3 || source.imagePlan.length > 5) {
    throw new RangeError('imagePlan must contain between 3 and 5 items');
  }
  const imageCount = source.imagePlan.length;
  const post = parsePostOutput(JSON.stringify({
    taskJudgement: {
      admitted: true,
      demandLevel: 'strong',
      primaryType: '教程',
      reason: '操作者已在独立图片试验模块确认该文案进入视觉生产。',
    },
    platform: {
      target: '小红书',
      expressionType: '信息型',
      audience: '由操作者提供并确认的目标受众',
      openingMethod: '沿用已完成文案，不在图片试验中改写。',
      bodyStructure: '沿用已完成文案和图片策划。',
      iconDictionary: {},
      sampleEvidence: 'not_provided',
    },
    title: boundedText(source.copy.title, 'copy.title', 1, 25),
    body: boundedText(source.copy.body, 'copy.body', 200, 700),
    tags: normalizedTags(source.copy.tags),
    imagePlan: source.imagePlan,
    sources: [],
    expressionReferences: [],
    riskFlags: [],
    fabricatedExperience: false,
    unverifiedClaims: [],
  }), { imageCount, allowedSources: [] });
  return { ...post, ...(source.imageSettings === undefined ? {} : { imageSettings: normalizeImageSettings(source.imageSettings) }) };
}

export function assertStandaloneImageConfirmation(mode, confirmation) {
  if (mode !== 'LIVE') throw new TypeError('mode must be LIVE');
  if (confirmation !== 'LIVE_IMAGE_COST_ACCEPTED') {
    throw new StandaloneImageConfirmationError();
  }
}

function qualitySummary(qc) {
  const issues = Array.isArray(qc?.issues) ? qc.issues.slice(0, 3) : [];
  if (issues.length === 0) return '图片生成与质量检查完成，等待人工抽查。';
  return issues.map((issue) => String(issue.label ?? '未命名问题')).join('；').slice(0, 500);
}

function publicTextList(value, field, {
  minimum = 0,
  maximum = 10,
  itemMaximum = 500,
} = {}) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    if (minimum === 0 && value === undefined) return [];
    throw new TypeError(`${field} is invalid`);
  }
  return value.map((item, index) => boundedText(item, `${field}[${index}]`, 1, itemMaximum));
}

function publicLayout(page, field = 'layout') {
  if (!isRecord(page) || !isRecord(page.allowedVisibleText)) {
    throw new TypeError(`${field} is invalid`);
  }
  return {
    ...(page.pageType ? { kind: page.kind ?? page.pageType.baseKind } : {}),
    ...planningMetadata({ ...page, kind: page.kind ?? page.pageType?.baseKind }),
    layoutTemplate: boundedText(page.layoutTemplate, `${field}.layoutTemplate`, 1, 64),
    layoutDirection: boundedText(page.layoutDirection, `${field}.layoutDirection`, 1, 300),
    visualSubject: boundedText(page.visualSubject, `${field}.visualSubject`, 1, 1000),
    allowedVisibleText: {
      headline: boundedText(page.allowedVisibleText.headline, `${field}.allowedVisibleText.headline`, 1, 18),
      subtitle: boundedText(page.allowedVisibleText.subtitle, `${field}.allowedVisibleText.subtitle`, 1, 30),
      bullets: publicTextList(page.allowedVisibleText.bullets, `${field}.allowedVisibleText.bullets`, {
        minimum: 2,
        maximum: 5,
        itemMaximum: 40,
      }),
      labels: publicTextList(page.allowedVisibleText.labels ?? [], `${field}.allowedVisibleText.labels`, {
        minimum: 0,
        maximum: 3,
        itemMaximum: 20,
      }),
    },
    mustShow: publicTextList(page.mustShow, `${field}.mustShow`, {
      minimum: 1,
      maximum: 10,
      itemMaximum: 100,
    }),
    mustAvoid: publicTextList(page.mustAvoid, `${field}.mustAvoid`, {
      minimum: 1,
      maximum: 10,
      itemMaximum: 100,
    }),
  };
}

function publicQualityIssues(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 30).flatMap((issue, index) => {
    if (!isRecord(issue)) return [];
    const label = String(issue.label ?? '').trim();
    const evidence = String(issue.evidence ?? '').trim();
    if (!label || !evidence) return [];
    return [{
      severity: typeof issue.severity === 'string'
        ? issue.severity.slice(0, 30)
        : 'warning',
      label: boundedText(label, `qc.issues[${index}].label`, 1, 100),
      evidence: boundedText(evidence, `qc.issues[${index}].evidence`, 1, 500),
    }];
  });
}

function publicStoredQualityDimensions(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 30).flatMap((dimension, index) => {
    if (!isRecord(dimension) || typeof dimension.key !== 'string') return [];
    return [{
      key: boundedText(dimension.key, `qc.dimensions[${index}].key`, 1, 100),
      score: Number.isInteger(dimension.score) ? dimension.score : null,
      applicable: dimension.applicable !== false,
      evidence: publicTextList(dimension.evidence ?? [], `qc.dimensions[${index}].evidence`, {
        minimum: 0,
        maximum: 20,
        itemMaximum: 500,
      }),
    }];
  });
}

function publicQualityDetails(qc) {
  const rubric = isRecord(qc?.rubric) ? qc.rubric : {};
  const dimensions = isRecord(rubric.dimensions)
    ? Object.entries(rubric.dimensions).flatMap(([key, dimension]) => {
      if (!isRecord(dimension)) return [];
      return [{
        key,
        score: Number.isInteger(dimension.score) ? dimension.score : null,
        applicable: dimension.applicable !== false,
        evidence: publicTextList(dimension.evidence ?? [], `qc.rubric.dimensions.${key}.evidence`, {
          minimum: 0,
          maximum: 20,
          itemMaximum: 500,
        }),
      }];
    })
    : [];
  const issueCandidates = [
    ...(Array.isArray(qc?.issues) ? qc.issues : []),
    ...(Array.isArray(rubric.issueLabels) ? rubric.issueLabels : []),
  ];
  const issues = publicQualityIssues(issueCandidates).filter((issue, index, collection) =>
    collection.findIndex((candidate) => candidate.label === issue.label
      && candidate.evidence === issue.evidence) === index);
  return {
    disposition: typeof qc?.disposition === 'string' ? qc.disposition.slice(0, 100) : 'not_available',
    action: typeof rubric.action === 'string' ? rubric.action.slice(0, 100) : null,
    issues,
    dimensions,
    limitations: publicTextList(qc?.limitations ?? [], 'qc.limitations', {
      minimum: 0,
      maximum: 10,
      itemMaximum: 500,
    }),
  };
}

function publicResult({ runId, mode, images, qc, visualPlan, planning, post, inputPost = post }) {
  const blocked = qc?.disposition === 'blocked'
    || qc?.issues?.some((issue) => issue?.severity === 'blocking');
  const qualityDetails = publicQualityDetails(qc);
  return {
    runId,
    mode,
    status: blocked ? 'BLOCKED' : 'COMPLETED',
    imageCount: images.length,
    ...(post?.imageSettings ? { imageSettings: post.imageSettings } : {}),
    ...(inputPost?.imageSettings || inputPost?.imagePlan?.some(page => page.layout) ? { imageControlsVersion: 1 } : {}),
    ...(post ? { imagePlan: post.imagePlan } : {}),
    images: images.map((image, index) => ({
      pageIndex: index + 1,
      kind: image.file.replace(/^\d{2}-/u, '').replace(/\.png$/u, ''),
      file: image.file,
      url: `/api/image-generations/${runId}/images/${image.file}`,
      ...publicImageArtifacts(image, runId),
      provider: image.provider,
      model: image.model ?? null,
      generationAttempts: image.generationAttempts ?? null,
      alignmentPassed: image.alignment?.passed ?? null,
      layout: publicLayout(visualPlan.pages[index], `visualPlan.pages[${index}]`),
    })),
    visualPlan: {
      planningMode: visualPlan.planningMode ?? 'LEGACY',
      skipped: planning?.skipped === true || visualPlan.planningMode === 'DIRECT',
      textContractSha256: visualPlan.textContractSha256 ?? null,
      model: typeof planning?.model === 'string' ? planning.model.slice(0, 200) : null,
      degraded: planning?.degraded === true,
      warning: normalizedOperationalNotice(planning?.warning, 'visualPlan.warning'),
    },
    qc: {
      passed: !blocked,
      overallScore: Number.isFinite(qc?.overallScore) ? Number(qc.overallScore) : null,
      summary: qualitySummary(qc),
      ...qualityDetails,
    },
  };
}

function visualReferenceForRuntime(value) {
  if (!value) return null;
  if (!isRecord(value)) throw new TypeError('visual reference must be an object');
  return value;
}

function escapedPromptVariable(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function onePassImageSystemPrompt(content) {
  return preserveImageSystemPrompt(content);
}

function buildDeliveryImageTaskPrompt(input) {
  return buildGovernedImageTaskPrompt(input);
}

function wrapAlignmentValidator(validator) {
  if (!validator) return undefined;
  return async (input) => {
    try {
      return await validator(input);
    } catch (error) {
      if (error instanceof ImageAlignmentResponseError) {
        throw new StandaloneImageAlignmentError(
          '图片已生成，但验收模型返回格式异常，可重新验收并继续',
          { cause: error, code: error.code, retryable: true },
        );
      }
      if (error instanceof ImageAlignmentServiceError) {
        throw new StandaloneImageAlignmentError(
          '图片已生成，但验收服务暂时不可用，可重新验收并继续',
          { cause: error, code: error.code, retryable: true },
        );
      }
      throw new StandaloneImageAlignmentError(undefined, { cause: error });
    }
  };
}

export function generateStandaloneImages(options) {
  return withPromptRuntime(options.runtime?.promptRuntime, () => generateStandaloneImagesInContext(options));
}
async function generateStandaloneImagesInContext({
  source,
  mode,
  runtime = {},
  outputRoot,
  runId: requestedRunId = String(randomUUID()),
  onProgress = undefined,
  recovery = null,
  signal = /** @type {AbortSignal | undefined} */ (undefined),
}) {
  const runId = validatedRunId(requestedRunId);
  const normalizedPost = normalizeStandaloneImageSource(source);
  const post = recovery ? normalizedPost : assignRandomLayouts(normalizedPost, runtime.productionSettings?.layoutPresets, Math.random, runtime.productionSettings?.planningCatalog);
  const query = boundedText(source.query, 'query', 1, 500);
  const imageCount = post.imagePlan.length;
  if (mode !== 'LIVE') throw new TypeError('mode must be LIVE');
  if (!runtime.client) throw new TypeError('Live mode requires an OpenClaw client');
  if (onProgress !== undefined && typeof onProgress !== 'function') {
    throw new TypeError('onProgress must be a function');
  }
  if (signal !== undefined && (typeof signal !== 'object' || typeof signal.aborted !== 'boolean')) {
    throw new TypeError('signal must be an AbortSignal');
  }
  throwIfCancelled(signal);
  const client = clientWithCancellation(runtime.client, signal);
  const outputDir = runDirectory(outputRoot, runId);
  await mkdir(resolve(outputRoot, RUN_DIRECTORY), { recursive: true });
  await mkdir(outputDir, { recursive: false });
  const modelApi = effectiveModelApiConfig(runtime.productionSettings?.modelApi);
  const provider = client.provider ?? modelApi.agentProvider.toLowerCase();
  const concurrency = provider === 'codex' ? 1 : Number(runtime.imageConcurrency ?? process.env.XHS_IMAGE_CONCURRENCY ?? 2);
  const reportProgress = createProgressReporter({
    outputDir,
    runId,
    mode,
    imageCount,
    onProgress,
    signal,
    timing: {
      databasePath: runtime.timingHistoryPath ?? join(outputRoot, 'image-stage-timing.sqlite'),
      profile: imageTimingProfile({ provider, imageCount, concurrency, modelApi }),
      thinking: modelApi.copyGenerationThinking, concurrency, recordSample: !recovery,
    },
  });
  const completedPages = new Set();
  const generatedPages = new Set();
  let activeStage = 'PREPARING';

  try {
    await reportProgress({
      stage: 'PREPARING',
      progressPercent: 3,
      message: '正在准备图片生成环境',
    });
    throwIfCancelled(signal);
    await writeJsonAtomic(join(outputDir, 'source.json'), { query, post, inputPost: recovery?.inputPost ?? normalizedPost });
    if (recovery?.images) await stageRecoveryImages({ images: recovery.images, outputDir });
    // Persist all inherited checkpoints before leaving PREPARING. If copying
    // fails, the executor can select the intact parent without losing work.
    if (recovery?.planned) await writeJsonAtomic(join(outputDir, 'visual-plan.json'), {
      model: recovery.planned.model,
      degraded: recovery.planned.degraded,
      warning: recovery.planned.warning,
      value: recovery.planned.visualPlan,
    });
    if (recovery?.imagePrompts) await writeJsonAtomic(join(outputDir, 'image-prompts.json'), {
      prompts: recovery.imagePrompts,
    });
    if (recovery?.assessed) await writeJsonAtomic(join(outputDir, 'quality-assessment.json'), {
      imageHashes: recovery.images.map((image) => image?.sha256 ?? null),
      assessment: { schemaVersion: 1, ...recovery.assessed.assessment },
      model: recovery.assessed.model,
    });
    await writeJsonAtomic(join(outputDir, 'prompt-runtime.json'), promptRuntimeSnapshot());
    const { modelApi: _transportOnly, ...frozenBusinessSettings } = normalizeProductionSettings(runtime.productionSettings ?? {});
    await writeJsonAtomic(join(outputDir, 'image-execution-config.json'), { schemaVersion: 1,
      productionSettings: frozenBusinessSettings, imageSystemPrompt: runtime.imageSystemPrompt ?? '', visualReference: runtime.visualReference ?? null });
    const productionSettings = normalizeProductionSettings(runtime.productionSettings ?? {});
    const complianceDisclosure = productionDisclosure(productionSettings);
    activeStage = 'PLANNING';
    await reportProgress({
      stage: 'PLANNING',
      progressPercent: 8,
      message: recovery?.planned ? '正在复用已完成的视觉规划' : '正在调用模型创建视觉规划',
    });
    throwIfCancelled(signal);
    const planned = recovery?.planned ?? await generateVisualPlan({ client, post, outputDir,
      thinking: effectiveModelApiConfig(runtime.productionSettings?.modelApi).copyGenerationThinking,
      complianceDisclosure,
      allowTransportFallback: isTransientModelFailure });
    throwIfCancelled(signal);
    const visualPlan = planned.visualPlan;
    await writeJsonAtomic(join(outputDir, 'visual-plan.json'), {
      model: planned.model,
      degraded: planned.degraded === true,
      warning: planned.warning ?? null,
      value: visualPlan,
    });
    await reportProgress({
      stage: 'PLANNING',
      progressPercent: 18,
      message: planned.skipped ? `视觉规划已关闭，使用原配图策划，共 ${imageCount} 页` : planned.degraded
        ? `视觉规划模型不可用，已切换确定性规划并继续生成，共 ${imageCount} 页`
        : `视觉规划已完成，共 ${imageCount} 页`,
      warning: planned.warning,
    });
    const visualReference = visualReferenceForRuntime(runtime.visualReference);
    const imagePrompts = recovery?.imagePrompts ?? post.imagePlan.map((plan, index) => {
      const variables = {
        query: escapedPromptVariable(query),
        category: '',
        targetAudience: '',
        imageIndex: index + 1,
        imageCount,
        reviewInstruction: '',
      };
      const pinnedImagePrompt = runtime.imageSystemPrompt
        ? renderPrompt(runtime.imageSystemPrompt, variables)
        : '';
      return composeVisualImagePrompt({
        systemPrompt: onePassImageSystemPrompt(pinnedImagePrompt, complianceDisclosure),
        visualReference,
        variables,
        pageKind: plan.kind,
        taskPrompt: buildDeliveryImageTaskPrompt({
          variables: { ...variables, query },
          post,
          plan,
          visualPage: visualPlan.pages[index],
          imageIndex: index + 1,
          imageCount,
          complianceDisclosure,
        }),
      });
    });
    await writeJsonAtomic(join(outputDir, 'image-prompts.json'), { prompts: imagePrompts });
    const validator = wrapAlignmentValidator(createImageAlignmentValidator({
      openclaw: client,
      post,
      visualPlan,
      imageCount,
      complianceDisclosure,
      onInvalidResponse: createAlignmentAttemptRecorder({
        outputDir,
        redact: sanitizedFailureDetail,
      }),
    }));
    let images;
    activeStage = 'GENERATING';
    try {
      await reportProgress({
        stage: 'GENERATING',
        progressPercent: 24,
        message: recovery ? '正在读取图片检查点并继续未完成的步骤' : `正在生成第 1/${imageCount} 页图片`,
      });
      images = await renderDeliveryImages({
        post,
        outputDir,
        mock: false,
        openclaw: client,
        imageCount,
        imagePrompts,
        visibleTextPlans: visualPlan.pages.map((page) => page.allowedVisibleText),
        layoutDirections: visualPlan.pages.map((page) => page.layoutDirection),
        layoutTemplates: visualPlan.pages.map((page) => page.layoutTemplate),
        complianceDisclosure,
        textRenderingMode: 'model-native',
        validateImage: validator,
        recoveryImages: recovery?.images ?? [],
        onImageCheckpoint: writeImageCheckpoint,
        maxGenerationAttempts: 3,
        imageConcurrency: runtime.imageConcurrency,
        heartbeat: async ({ stage, pageIndex, attempt }) => {
          const aligning = stage === 'image_alignment';
          if (aligning) generatedPages.add(pageIndex);
          await reportProgress({
            stage: aligning ? 'ALIGNING' : 'GENERATING',
            progressPercent: 24 + Math.round(completedPages.size / imageCount * 54),
            completedImages: completedPages.size,
            generatedImages: generatedPages.size,
            validatedImages: completedPages.size,
            currentPage: pageIndex,
            attempt,
            message: aligning
              ? `正在检查第 ${pageIndex}/${imageCount} 页图文对齐（第 ${attempt} 次）`
              : `正在生成第 ${pageIndex}/${imageCount} 页图片（第 ${attempt} 次）`,
          });
        },
        onImageCompleted: async ({ pageIndex, image, outputPath }) => {
          await writeImageCheckpoint({ image, outputPath, completed: true });
          completedPages.add(pageIndex);
          generatedPages.add(pageIndex);
          await reportProgress({
            stage: 'GENERATING',
            progressPercent: 24 + Math.round(completedPages.size / imageCount * 56),
            completedImages: completedPages.size,
            generatedImages: generatedPages.size,
            validatedImages: completedPages.size,
            currentPage: pageIndex,
            message: `已完成 ${completedPages.size}/${imageCount} 页图片`,
          });
        },
      });
    } catch (error) {
      if (error?.code === 'STALE_EXECUTION' || error instanceof StandaloneImageAlignmentError) throw error;
      throw new StandaloneImageGenerationError(undefined, { cause: error });
    }
    await reportProgress({
      stage: 'GENERATING',
      progressPercent: 80,
      completedImages: imageCount,
      message: `${imageCount} 页图片已全部生成`,
    });
    activeStage = 'QUALITY_CHECK';
    await reportProgress({
      stage: 'QUALITY_CHECK',
      progressPercent: 85,
      completedImages: imageCount,
      message: recovery?.assessed ? '正在复用整套图片质量检查结果' : '正在进行整套图片质量检查',
    });
    const assessed = recovery?.assessed ?? await createDeliveryQualityAssessor({
      openclaw: client,
      task: { query, input: {} },
      post,
      model: productionSettings.modelApi.qualityModel,
    })({ imagePaths: images.map((image) => join(outputDir, image.file)) });
    const savedImages = await discoverStandaloneRecoveryImages({ outputDir, post });
    await writeJsonAtomic(join(outputDir, 'quality-assessment.json'), {
      imageHashes: savedImages.map((image) => image?.sha256 ?? null),
      assessment: { schemaVersion: 1, ...assessed.assessment },
      model: assessed.model,
    });
    await reportProgress({
      stage: 'QUALITY_CHECK',
      progressPercent: 92,
      completedImages: imageCount,
      message: '正在汇总图片质量与机械检查结果',
    });
    const qc = await evaluateDelivery({
      post,
      images,
      outputDir,
      mode: 'live',
      expectedImageCount: imageCount,
      rubricAssessment: assessed.assessment,
    });
    const result = publicResult({
      runId,
      mode,
      images,
      qc,
      visualPlan,
      planning: planned,
      post,
      inputPost: recovery?.inputPost ?? normalizedPost,
    });
    activeStage = 'FINALIZING';
    await reportProgress({
      stage: 'FINALIZING',
      progressPercent: 96,
      completedImages: imageCount,
      message: '正在保存运行结果和图片清单',
    });
    await writeJsonAtomic(join(outputDir, 'qc.json'), qc);
    await writeJsonAtomic(join(outputDir, 'result.json'), result);
    await reportProgress({
      stage: 'COMPLETED',
      progressPercent: 100,
      completedImages: imageCount,
      message: '图片生成和质量检查完成',
      result,
    });
    return result;
  } catch (error) {
    if (error?.code === 'STALE_EXECUTION') throw error;
    if (error instanceof StandaloneImageCancellationError || signal?.aborted) {
      const cancelled = error instanceof StandaloneImageCancellationError
        ? error
        : cancellationError(signal);
      const discoveredImages = await countStandaloneGeneratedImages(outputDir, imageCount)
        .catch(() => generatedPages.size);
      const generatedImages = Math.max(generatedPages.size, discoveredImages);
      const canResume = generatedImages > 0;
      await reportProgress({
        stage: 'CANCELLED',
        progressPercent: 0,
        completedImages: completedPages.size,
        generatedImages,
        validatedImages: completedPages.size,
        message: cancelled.message,
        canResume,
        retryReason: canResume ? 'CANCELLED' : null,
      }).catch(() => {});
      throw cancelled;
    }
    const failure = error instanceof StandaloneImageAlignmentError
      || error instanceof StandaloneImageGenerationError
      ? error
      : new StandaloneImageGenerationError(undefined, {
        cause: error,
        stage: activeStage,
        code: `${activeStage}_FAILED`,
      });
    const diagnostic = failureDiagnostic(failure, activeStage);
    const retryReason = recoverableAlignmentReason(diagnostic) ?? diagnostic.code;
    await reportProgress({
      stage: 'FAILED',
      progressPercent: 99,
      completedImages: completedPages.size,
      generatedImages: generatedPages.size,
      validatedImages: completedPages.size,
      message: failure.message,
      error: failure.message,
      diagnostic,
      canResume: retryReason !== null,
      retryReason,
    }).catch(() => {});
    throw failure;
  }
}

export async function readStandaloneImagePromptRuntime(outputRoot, runId) {
  const value = await readExecutionArtifact(runDirectory(outputRoot, validatedRunId(runId)), 'prompt-runtime.json', { nullable: true });
  return value === null ? null : createPromptRuntime(value);
}

export async function retryStandaloneImageRun({
  sourceRunId: rawSourceRunId,
  runId: rawRunId = String(randomUUID()),
  runtime = {},
  outputRoot,
  onProgress = undefined,
  signal = /** @type {AbortSignal | undefined} */ (undefined),
  allowInterrupted = false,
  expectedSource = undefined,
}) {
  const sourceRunId = validatedRunId(rawSourceRunId);
  const runId = validatedRunId(rawRunId);
  if (sourceRunId === runId) {
    throw new StandaloneImageRecoveryError('恢复运行必须使用新的运行 ID');
  }
  const sourceProgress = await readStandaloneImageProgress({ outputRoot, runId: sourceRunId });
  if (sourceProgress.mode !== 'LIVE'
    || (!['FAILED', 'CANCELLED'].includes(sourceProgress.status)
      && !(allowInterrupted && ['RUNNING', 'COMPLETED'].includes(sourceProgress.status)))) {
    throw new StandaloneImageRecoveryError('当前图片运行不支持恢复');
  }
  const sourceOutputDir = runDirectory(outputRoot, sourceRunId);
  const [storedSource, storedPlan, storedPrompts, storedAssessment] = await Promise.all([
    readExecutionArtifact(sourceOutputDir, 'source.json'),
    readExecutionArtifact(sourceOutputDir, 'visual-plan.json', { optional: true }),
    readExecutionArtifact(sourceOutputDir, 'image-prompts.json', { optional: true }),
    readExecutionArtifact(sourceOutputDir, 'quality-assessment.json', { optional: true }),
  ]);
  const storedRuntime = await readStandaloneImagePromptRuntime(outputRoot, sourceRunId);
  const executionConfig = await readExecutionArtifact(sourceOutputDir, 'image-execution-config.json');
  if (executionConfig && executionConfig.schemaVersion !== 1) throw new StandaloneImageRecoveryError('原执行的业务配置快照格式无效');
  if (!executionConfig) throw new StandaloneImageRecoveryError('原执行缺少附加业务配置快照，无法确认原审核与修复规则。历史产物可查看；请从原文案新建图片执行，不能用当前规则覆盖后恢复');
  const source = sourceForStandaloneRecovery(storedSource);
  const post = normalizeStandaloneImageSource(source);
  // Compare the submitted source, before automatic layout selection, while
  // keeping the resolved post for all recovered planning and image work.
  const inputPost = storedSource.inputPost ?? post;
  if (expectedSource && (JSON.stringify(normalizeStandaloneImageSource(expectedSource)) !== JSON.stringify(inputPost)
    || expectedSource.query !== source.query)) {
    throw new StandaloneImageRecoveryError('原运行文案与当前任务不一致，不能复用旧图片');
  }
  const planned = storedPlan ? plannedForStandaloneRecovery({
    storedPlan,
    post,
    normalizeNotice: normalizedOperationalNotice,
  }) : null;
  const images = await discoverStandaloneRecoveryImages({ outputDir: sourceOutputDir, post });
  const imagePrompts = storedPrompts?.prompts;
  if (imagePrompts && (!Array.isArray(imagePrompts) || imagePrompts.length !== post.imagePlan.length
    || imagePrompts.some((prompt) => typeof prompt !== 'string' || prompt.length < 10 || Buffer.byteLength(prompt, 'utf8') > 200_000))) {
    throw new StandaloneImageRecoveryError('原运行图片提示词检查点无效');
  }
  let assessed;
  if (storedAssessment && planned && images.every((image) => image?.completed)
    && JSON.stringify(storedAssessment.imageHashes) === JSON.stringify(images.map((image) => image.sha256))) {
    assessed = {
      assessment: parseDeliveryQualityAssessmentOutput(JSON.stringify(storedAssessment.assessment)),
      model: storedAssessment.model,
    };
  }
  return generateStandaloneImages({
    source,
    mode: 'LIVE',
    runtime: { ...runtime, ...(executionConfig ? { imageSystemPrompt: executionConfig.imageSystemPrompt, visualReference: executionConfig.visualReference,
      productionSettings: { ...executionConfig.productionSettings, modelApi: runtime.productionSettings?.modelApi } } : {}), promptRuntime: storedRuntime ?? null },
    outputRoot,
    runId,
    onProgress,
    signal,
    recovery: {
      inputPost,
      planned,
      images,
      imagePrompts,
      assessed,
    },
  });
}

export async function cancelStandaloneImageRun({ outputRoot, runId: rawRunId }) {
  const runId = validatedRunId(rawRunId);
  const progress = await readStandaloneImageProgress({ outputRoot, runId });
  if (progress.status !== 'RUNNING') return progress;
  const now = new Date();
  const canResume = progress.generatedImages > 0;
  await writeJsonAtomic(join(runDirectory(outputRoot, runId), PROGRESS_FILE), {
    ...progress,
    status: 'CANCELLED',
    stage: 'CANCELLED',
    message: '图片生成已取消',
    updatedAt: now.toISOString(),
    finishedAt: now.toISOString(),
    elapsedMs: Math.max(0, now.getTime() - Date.parse(progress.startedAt)),
    estimatedRemainingMs: 0,
    estimateOverdue: false,
    canResume,
    retryReason: canResume ? 'CANCELLED' : null,
    error: null,
    result: null,
  });
  return readStandaloneImageProgress({ outputRoot, runId });
}

export async function readStandaloneImageProgress({ outputRoot, runId: rawRunId }) {
  const runId = validatedRunId(rawRunId);
  const outputDir = runDirectory(outputRoot, runId);
  const content = await readFile(join(outputDir, PROGRESS_FILE));
  if (content.byteLength > MANIFEST_MAX_BYTES) throw new Error('standalone image progress is too large');
  let value;
  try {
    value = JSON.parse(content.toString('utf8'));
  } catch {
    throw new TypeError('standalone image progress is invalid');
  }
  if (!isRecord(value) || value.runId !== runId || !['MOCK', 'LIVE'].includes(value.mode)
    || !['RUNNING', 'COMPLETED', 'CANCELLED', 'FAILED'].includes(value.status)
    || !PROGRESS_STAGES.has(value.stage)
    || !Number.isInteger(value.progressPercent) || value.progressPercent < 0 || value.progressPercent > 100
    || !Number.isInteger(value.completedImages) || value.completedImages < 0
    || !Number.isInteger(value.totalImages) || value.totalImages < 3 || value.totalImages > 5
    || value.completedImages > value.totalImages
    || !Number.isFinite(value.estimatedTotalMs) || value.estimatedTotalMs < 1_000) {
    throw new TypeError('standalone image progress is invalid');
  }
  const startedAtMs = Date.parse(value.startedAt);
  const updatedAtMs = Date.parse(value.updatedAt);
  const finishedAtMs = value.finishedAt === null ? null : Date.parse(value.finishedAt);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(updatedAtMs)
    || (finishedAtMs !== null && !Number.isFinite(finishedAtMs))) {
    throw new TypeError('standalone image progress timestamps are invalid');
  }
  const elapsedMs = Math.max(0, (finishedAtMs ?? Date.now()) - startedAtMs);
  const stageOverdue = ['stage-history', 'stage-defaults'].includes(value.estimateBasis)
    && Number.isFinite(value.estimatedStageDeadlineElapsedMs)
    && elapsedMs > value.estimatedStageDeadlineElapsedMs;
  const estimateOverdue = value.status === 'RUNNING' && (stageOverdue || elapsedMs >= value.estimatedTotalMs);
  if (value.warnings !== undefined
    && (!Array.isArray(value.warnings) || value.warnings.length > 10)) {
    throw new TypeError('standalone image progress warnings are invalid');
  }
  const warnings = (value.warnings ?? []).map((warning, index) =>
    normalizedOperationalNotice(warning, `progress.warnings[${index}]`));
  const diagnostic = normalizedOperationalNotice(value.diagnostic, 'progress.diagnostic');
  const storedGeneratedImages = Number.isInteger(value.generatedImages)
    ? Math.min(value.totalImages, Math.max(value.completedImages, value.generatedImages))
    : value.completedImages;
  const discoveredGeneratedImages = await countStandaloneGeneratedImages(
    outputDir,
    value.totalImages,
  );
  const generatedImages = Math.min(
    value.totalImages,
    Math.max(storedGeneratedImages, discoveredGeneratedImages),
  );
  const validatedImages = Number.isInteger(value.validatedImages)
    ? Math.min(value.totalImages, Math.max(value.completedImages, value.validatedImages))
    : value.completedImages;
  const inferredRetryReason = value.status === 'FAILED'
    ? recoverableAlignmentReason(diagnostic)
    : null;
  const retryReason = typeof value.retryReason === 'string'
    ? value.retryReason
    : inferredRetryReason;
  const canResume = value.status === 'FAILED'
    || (value.status === 'CANCELLED' && generatedImages > 0);
  const result = value.status === 'COMPLETED'
    ? await enrichStoredResult(outputDir, normalizedStoredResult(value.result, runId))
    : null;
  return {
    runId,
    mode: value.mode,
    status: value.status,
    stage: value.stage,
    progressPercent: value.progressPercent,
    message: boundedText(value.message, 'progress.message', 1, 500),
    completedImages: value.completedImages,
    generatedImages,
    validatedImages,
    totalImages: value.totalImages,
    currentPage: Number.isInteger(value.currentPage) && value.currentPage >= 1
      && value.currentPage <= value.totalImages ? value.currentPage : null,
    attempt: Number.isInteger(value.attempt) && value.attempt >= 1 ? value.attempt : null,
    startedAt: new Date(startedAtMs).toISOString(),
    updatedAt: new Date(updatedAtMs).toISOString(),
    finishedAt: finishedAtMs === null ? null : new Date(finishedAtMs).toISOString(),
    estimatedTotalMs: value.estimatedTotalMs,
    elapsedMs,
    estimatedRemainingMs: value.status === 'RUNNING'
      ? estimateOverdue ? null : Math.max(0, value.estimatedTotalMs - elapsedMs)
      : 0,
    estimateBasis: ['stage-history', 'stage-defaults'].includes(value.estimateBasis)
      ? value.estimateBasis : 'mode-and-page-count',
    estimateSampleSize: Number.isInteger(value.estimateSampleSize) ? Math.max(0, Math.min(30, value.estimateSampleSize)) : 0,
    estimateOverdue,
    warnings,
    diagnostic,
    canResume,
    retryReason: canResume ? retryReason ?? diagnostic?.code ?? value.stage : null,
    error: typeof value.error === 'string' ? value.error.slice(0, 500) : null,
    result,
  };
}

function historySourceSummary(value) {
  const query = typeof value?.query === 'string' ? value.query.trim() : '';
  const title = typeof value?.post?.title === 'string' ? value.post.title.trim() : '';
  return {
    query: query ? [...query].slice(0, 500).join('') : '旧记录未保存输入内容',
    title: title ? [...title].slice(0, 25).join('') : '未命名图片试验',
  };
}

export async function listStandaloneImageRuns({ outputRoot, limit: rawLimit = 50 }) {
  const limit = Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError('standalone image history limit must be an integer between 1 and 100');
  }
  const root = resolve(outputRoot, RUN_DIRECTORY);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return { data: [], total: 0 };
    throw error;
  }
  const records = (await Promise.all(entries
    .filter((entry) => entry.isDirectory() && RUN_ID.test(entry.name))
    .map(async (entry) => {
      try {
        const progress = await readStandaloneImageProgress({ outputRoot, runId: entry.name });
        if (progress.mode !== 'LIVE') return null;
        const source = await readOptionalRunArtifact(
          runDirectory(outputRoot, entry.name),
          'source.json',
        );
        return {
          runId: entry.name,
          ...historySourceSummary(source),
          mode: progress.mode,
          status: progress.status,
          stage: progress.stage,
          completedImages: progress.completedImages,
          generatedImages: progress.generatedImages,
          validatedImages: progress.validatedImages,
          canResume: progress.canResume,
          retryReason: progress.retryReason,
          imageCount: progress.totalImages,
          qcScore: progress.result?.qc?.overallScore ?? null,
          startedAt: progress.startedAt,
          updatedAt: progress.updatedAt,
          finishedAt: progress.finishedAt,
          error: progress.error,
        };
      } catch {
        return null;
      }
    })))
    .filter(Boolean)
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt)
      || right.runId.localeCompare(left.runId));
  return {
    data: records.slice(0, limit),
    total: records.length,
  };
}

export async function readStandaloneImageFile({ outputRoot, runId: rawRunId, file: rawFile }) {
  const runId = validatedRunId(rawRunId);
  const file = String(rawFile ?? '');
  if (!IMAGE_ARTIFACT_FILE.test(file)) throw new TypeError('standalone image file name is invalid');
  const outputDir = runDirectory(outputRoot, runId);
  const manifestContent = await readFile(join(outputDir, 'result.json'));
  if (manifestContent.byteLength > MANIFEST_MAX_BYTES) throw new Error('standalone image manifest is too large');
  let manifest;
  try {
    manifest = JSON.parse(manifestContent.toString('utf8'));
  } catch {
    throw new TypeError('standalone image manifest is invalid');
  }
  if (!isRecord(manifest) || manifest.runId !== runId || !Array.isArray(manifest.images)
    || !manifest.images.some((image) => [image?.file, image?.sourceFile, image?.deliveryFile].includes(file))) {
    throw new Error('image is not part of this run');
  }
  const path = resolve(outputDir, file);
  const relation = relative(outputDir, path);
  if (!relation || relation.startsWith('..')) throw new Error('standalone image path escaped the run');
  const content = await readFile(path);
  if (content.byteLength > IMAGE_MAX_BYTES) throw new Error('standalone image file is too large');
  const extensions = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif', tiff: 'image/tiff', gif: 'image/gif' };
  return { content, file, mediaType: extensions[file.split('.').at(-1)] };
}

export async function reprocessStandaloneImages({ source, originalResult, loadSource, outputRoot,
  runId: requestedRunId = String(randomUUID()), onProgress, signal, originalAvailable = true }) {
  const runId = validatedRunId(requestedRunId);
  const post = normalizeStandaloneImageSource(source);
  post.imageSettings = normalizeImageSettings(source.imageSettings);
  if (!Array.isArray(originalResult?.images) || originalResult.images.length !== post.imagePlan.length) throw new TypeError('原图片版本不完整');
  const sourceRunId = validatedRunId(originalResult.runId);
  originalAvailable = originalAvailable && originalResult.processing?.originalAvailable !== false
    && originalResult.images.every(image => image.sourceOriginal !== false);
  const outputDir = runDirectory(outputRoot, runId);
  await mkdir(resolve(outputRoot, RUN_DIRECTORY), { recursive: true });
  await mkdir(outputDir, { recursive: false });
  const report = createProgressReporter({ outputDir, runId, mode: 'LIVE', imageCount: post.imagePlan.length,
    onProgress, signal, timing: { recordSample: false } });
  try {
    await writeJsonAtomic(join(outputDir, 'source.json'), { query: source.query, post });
    await report({ stage: 'PREPARING', progressPercent: 5, message: '正在读取源图，转换过程不调用模型' });
    const images = [];
    for (const [index, image] of originalResult.images.entries()) {
      throwIfCancelled(signal);
      const file = `${String(index + 1).padStart(2, '0')}-${post.imagePlan[index].kind}.png`;
      const bytes = await loadSource(image, index);
      const artifacts = await prepareImageArtifacts({ source: bytes, outputDir, file, settings: post.imageSettings });
      artifacts.sourceOriginal = originalAvailable;
      images.push({ ...image, ...publicImageArtifacts(artifacts, runId), file,
        pageIndex: index + 1, kind: post.imagePlan[index].kind, url: `/api/image-generations/${runId}/images/${file}`,
        alignmentPassed: null });
      await report({ stage: 'FINALIZING', progressPercent: 10 + Math.round((index + 1) / post.imagePlan.length * 80),
        message: `已转换 ${index + 1}/${post.imagePlan.length} 张，等待人工检查`, completedImages: index + 1 });
    }
    const result = { runId, mode: 'LIVE', status: originalResult.status === 'BLOCKED' ? 'BLOCKED' : 'COMPLETED', imageCount: images.length, images,
      imageSettings: post.imageSettings, imagePlan: post.imagePlan, imageControlsVersion: 1,
      processing: { type: 'LOCAL', sourceRunId, originalAvailable }, visualPlan: originalResult.visualPlan ?? null,
      qc: { passed: false, overallScore: null, disposition: 'manual_review_required', action: null,
        summary: '格式与背景转换完成，未重新调用模型验收，请人工检查文字、底色和透明边缘。',
        issues: [], dimensions: [], limitations: [originalAvailable ? '原模型来源保留；当前版本仅进行本地图片处理。' : '历史版本未保存处理前源图，基于已有成品转换，不能恢复已丢失的透明像素。'] } };
    await writeJsonAtomic(join(outputDir, 'result.json'), result);
    await report({ stage: 'COMPLETED', progressPercent: 100, message: result.qc.summary, completedImages: images.length, result });
    return result;
  } catch (error) {
    await report({ stage: 'FAILED', progressPercent: 99, message: '图片转换失败', error: sanitizedFailureDetail(error), canResume: false }).catch(() => {});
    throw error;
  }
}

export async function convertStandaloneImageRun({ outputRoot, sourceRunId, imageSettings, ...options }) {
  const original = await readStandaloneImageProgress({ outputRoot, runId: sourceRunId });
  if (!original.result || original.status !== 'COMPLETED') throw new TypeError('只能转换已完成的图片版本');
  const stored = JSON.parse(await readFile(join(runDirectory(outputRoot, sourceRunId), 'source.json'), 'utf8'));
  return reprocessStandaloneImages({ ...options, outputRoot,
    source: { ...sourceForStandaloneRecovery(stored), imageSettings }, originalResult: original.result,
    originalAvailable: original.result.images.every(image => image.sourceFile),
    loadSource: async image => (await readStandaloneImageFile({ outputRoot, runId: sourceRunId, file: image.sourceFile ?? image.file })).content });
}
