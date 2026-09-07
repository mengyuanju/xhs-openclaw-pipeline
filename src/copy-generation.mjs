import { businessPrompt, promptPolicy, promptRuntimeSnapshot, withPromptRuntime } from './prompt-runtime.mjs';
import { performance } from 'node:perf_hooks';
import { buildCopyKnowledgeReferencePrompt, matchCopyKnowledge } from './copy-knowledge-match.mjs';
import { normalizePlanningCatalog, planningCatalogPrompt } from '../server/src/planning-catalog.mjs';
import { assignRandomLayouts } from './image-layout-controls.mjs';

import {
  describeStageReviewFailure,
  runQueryReview,
  runTextReview,
} from './content-stage-review.mjs';
import { createAgentClient as createOpenClawClient } from './agent-client.mjs';
import {
  buildPostPrompt,
  filterAllowedSourceReferences,
  normalizeProseLineBreaks,
  parsePostCandidate,
  parsePostOutput,
} from './post-contract.mjs';
import {
  attachResearchToTask,
  createResearchSnapshot,
  researchSourceUrls,
} from './research.mjs';

const POST_MAX_ATTEMPTS = 3;
const QUALITY_REVISION_MAX_ATTEMPTS = 2;
const TRANSIENT_MODEL_FAILURE = /\b(?:ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|UND_ERR_SOCKET|429)\b|fetch failed|connection error|other side closed|socket hang up|timed? out|terminated|no text output returned|temporar(?:y|ily) unavailable|rate limit/iu;
const MODEL_NOT_ALLOWED_FAILURE = /model override\b.{0,300}\bis not allowed for agent\b/iu;
const COPY_GENERATION_STAGE_LABELS = Object.freeze({
  QUERY_REVIEW: '选题审核',
  KNOWLEDGE_MATCH: '优秀案例匹配',
  ORIGINAL_GENERATION: '首稿生成',
  ORIGINAL_REVIEW: '首稿审核',
  REVIEWED_GENERATION: '质检修订',
  REVIEWED_REVIEW: '修订复检',
});

function disabledTextReviewResult() {
  return {
    schemaVersion: 1,
    decision: 'PASS',
    summary: '自动文案质检已关闭，当前结果未经自动质检。',
    issues: [],
    skipped: true,
  };
}

function elapsedMilliseconds(now, startedAt) {
  const finishedAt = Number(now());
  const normalizedStart = Number(startedAt);
  if (!Number.isFinite(finishedAt) || !Number.isFinite(normalizedStart)) return 0;
  return Math.max(0, Math.round(finishedAt - normalizedStart));
}

async function measureStage(timing, field, now, operation) {
  const startedAt = now();
  try {
    return await operation();
  } finally {
    timing[field] = elapsedMilliseconds(now, startedAt);
  }
}

function failureChainText(error) {
  const messages = [];
  let current = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    messages.push(String(current instanceof Error ? current.message : current));
    current = current instanceof Error ? current.cause : null;
  }
  return messages.join(' ');
}

async function measureModelStage(timing, field, stage, now, operation) {
  try {
    return await measureStage(timing, field, now, operation);
  } catch (error) {
    if (error instanceof CopyGenerationTransportError) throw error;
    const failureText = failureChainText(error);
    if (TRANSIENT_MODEL_FAILURE.test(failureText)
      || MODEL_NOT_ALLOWED_FAILURE.test(failureText)) {
      throw new CopyGenerationTransportError(stage, error);
    }
    throw error;
  }
}

function normalizedTask(task) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    throw new TypeError('copy generation task must be an object');
  }
  const query = typeof task.query === 'string' ? task.query.trim() : '';
  if (query.length < 1 || [...query].length > 500) {
    throw new RangeError('query must contain between 1 and 500 characters');
  }
  const input = task.input ?? {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('copy generation input must be an object');
  }
  return { ...task, query, input };
}

function buildPostRepairPrompt(task, error, previousOutput, options = {}) {
  const validationError = error instanceof Error ? error.message : String(error);
  const lengthRepair = /^body must contain between/.test(validationError);
  const receivedLength = validationError.match(/received ([0-9]+)/)?.[1];
  return businessPrompt(lengthRepair ? 'COPY_LENGTH_REPAIR_SYSTEM' : 'COPY_REPAIR_SYSTEM', {
    variables: { query: task.query,
      category: task.input?.category ?? '', targetAudience: task.input?.targetAudience ?? '', imageCount: options.imageCount ?? '' },
    inherits: promptRuntimeSnapshot() ? ['TEXT_SYSTEM', 'COPY_IMAGE_PLAN_SYSTEM'] : [],
    contract: `沿用本次编辑要求：\n${promptRuntimeSnapshot() ? '' : options.systemPrompt ?? ''}\n${lengthRepair ? '仅返回 {"body":"修订后完整正文"}，其他字段由程序保留。正文有效范围400～600。' : '返回与上一稿相同字段的完整合法 JSON，仅修改失败字段及必要联动。'}`,
    data: { query: task.query, validationError, previousOutput, receivedLength: receivedLength ? Number(receivedLength) : null,
      countingRule: '英文字母、数字、标点、空格和换行均逐个计数，英文单词不能按一个字计算',
      allowedFields: lengthRepair ? ['body'] : repairFieldsFor(error) },
  }) + planningCatalogPrompt(options.planningCatalog);
}

const REPAIRABLE_POST_FIELDS = new Set([
  'body',
  'expressionReferences',
  'fabricatedExperience',
  'imagePlan',
  'platform',
  'riskFlags',
  'sources',
  'tags',
  'taskJudgement',
  'title',
  'unverifiedClaims',
]);

function repairFieldsFor(error) {
  const message = String(error?.message ?? error);
  if (/fabricated experience/iu.test(message)) return ['body', 'fabricatedExperience'];
  if (/^itinerary\b/iu.test(message)) return ['body'];
  const field = message.match(/^([A-Za-z][A-Za-z0-9]*)/u)?.[1];
  return REPAIRABLE_POST_FIELDS.has(field) ? [field] : [];
}

function mergeTargetedRepair(previousCandidate, nextCandidate, error) {
  if (!previousCandidate) return nextCandidate;
  const fields = repairFieldsFor(error);
  if (fields.length === 0) return nextCandidate;
  const repaired = { ...previousCandidate };
  for (const field of fields) {
    if (Object.hasOwn(nextCandidate, field)) repaired[field] = nextCandidate[field];
  }
  return repaired;
}

function filterCandidateSources(candidate, allowedSources = []) {
  if (!Array.isArray(candidate?.sources)) return candidate;
  return {
    ...candidate,
    sources: filterAllowedSourceReferences(candidate.sources, allowedSources),
  };
}

function escapedUntrustedJson(value, field) {
  const serialized = JSON.stringify(value, null, 2);
  if (typeof serialized !== 'string' || serialized.length > 20_000) {
    throw new RangeError(`${field} is too large for copy quality revision`);
  }
  return serialized
    .replaceAll('&', '\\u0026')
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e');
}

function buildQualityRevisionPrompt(
  task,
  originalPost,
  originalReview,
  options,
  { unchangedRetry = false } = {},
) {
  const basePrompt = buildPostPrompt(task, options);
  return `${basePrompt}\n\n${businessPrompt('COPY_REVISION_SYSTEM', {
    contract: '只返回与原文案相同结构的合法 JSON。已经合格字段由原编辑规则保护；不得为产生变化随意修改。',
    dataTag: 'untrusted_quality_revision',
    data: { originalPost, originalReview, previousRepairUnresolved: unchangedRetry },
  })}`;
}

function normalizedComparableValue(value) {
  if (typeof value === 'string') {
    return value.normalize('NFKC').replace(/\s+/gu, '');
  }
  if (Array.isArray(value)) return value.map(normalizedComparableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, normalizedComparableValue(value[key])]),
    );
  }
  return value;
}

function revisionFingerprint(post) {
  const tags = post.tags
    .map((tag) => normalizedComparableValue(tag))
    .sort((left, right) => left.localeCompare(right, 'zh-CN'));
  return JSON.stringify(normalizedComparableValue({
    title: post.title,
    body: post.body,
    tags,
    imagePlan: post.imagePlan,
  }));
}

export function describeResearchFailure(snapshot) {
  const details = Array.isArray(snapshot?.attempts)
    ? snapshot.attempts.map((attempt) => `${attempt.provider}：${attempt.error ?? '没有公开来源'}`)
      .join('；')
    : '没有可用的检索结果';
  return `联网研究失败：${details}`;
}

export class CopyGenerationRejectedError extends Error {
  constructor(stage, review) {
    super(describeStageReviewFailure(review));
    this.name = 'CopyGenerationRejectedError';
    this.stage = stage;
    this.review = review;
  }
}

export class CopyGenerationResearchError extends Error {
  constructor(snapshot) {
    super(describeResearchFailure(snapshot));
    this.name = 'CopyGenerationResearchError';
    this.snapshot = snapshot;
  }
}

export class CopyGenerationUnchangedError extends Error {
  constructor() {
    super('质检版连续两次没有产生实际修改，本次结果未保存，请重新生成');
    this.name = 'CopyGenerationUnchangedError';
  }
}

export class CopyGenerationTransportError extends Error {
  constructor(stage, cause) {
    const label = COPY_GENERATION_STAGE_LABELS[stage];
    if (!label) throw new TypeError('copy generation transport stage is invalid');
    const message = MODEL_NOT_ALLOWED_FAILURE.test(failureChainText(cause))
      ? `当前模型未被代理允许（阶段：${label}），请检查模型配置后重试`
      : `模型连接中断，已自动重试仍失败（阶段：${label}），请稍后重试`;
    super(message, { cause });
    this.name = 'CopyGenerationTransportError';
    this.stage = stage;
  }
}

function contractFailureReason(error) {
  const message = String(error?.message ?? error);
  if (/title cannot merely repeat the Query/iu.test(message)) return '标题不能照抄 Query';
  if (/title cannot use a question form/iu.test(message)) return '标题不能使用疑问句';
  if (/body must contain between 400 and 600/iu.test(message)) {
    const received = message.match(/received (\d+)/u)?.[1];
    return `正文必须控制在400～600字${received === undefined ? '' : `（当前${received}个可见字符）`}`;
  }
  if (/fabricated experience/iu.test(message)) return '正文不能虚构第一人称使用或实测经历';
  if (/valid JSON object/iu.test(message)) return '模型输出不是合法 JSON';
  return '标题、正文或配图规划未通过结构校验';
}

export class CopyGenerationContractError extends Error {
  constructor(error) {
    super(`模型连续三次未按规则返回合格文案：${contractFailureReason(error)}`, { cause: error });
    this.name = 'CopyGenerationContractError';
  }
}

async function createPostFromPrompt(client, task, basePrompt, options) {
  if (typeof client?.runText !== 'function') {
    throw new TypeError('OpenClaw text client is required');
  }
  let lastError;
  let previousOutput = '';
  let previousCandidate = null;
  for (let attempt = 0; attempt < POST_MAX_ATTEMPTS; attempt += 1) {
    const generated = await client.runText({
      prompt: attempt === 0
        ? basePrompt
        : `${buildPostRepairPrompt(task, lastError, previousOutput, options)}\n\n${buildCopyKnowledgeReferencePrompt(options.knowledgeReference)}`,
      thinking: options.thinking,
    });
    previousOutput = generated.rawText;
    try {
      const generatedCandidate = parsePostCandidate(generated.rawText);
      const candidate = filterCandidateSources(
        attempt === 0
          ? generatedCandidate
          : mergeTargetedRepair(previousCandidate, generatedCandidate, lastError),
        options.allowedSources,
      );
      previousCandidate = candidate;
      previousOutput = JSON.stringify(candidate);
      const post = parsePostOutput(JSON.stringify(candidate), {
          imageCount: options.imageCount,
          allowedSources: options.allowedSources,
          query: task.query,
          planningCatalog: options.planningCatalog,
        });
      return {
        post: options.planningCatalog ? assignRandomLayouts(post, [], Math.random, options.planningCatalog) : post,
        model: generated.model,
        thinking: typeof generated.thinking === 'string' ? generated.thinking.slice(0, 20) : null,
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw new CopyGenerationContractError(lastError);
}

export function createLivePost(client, task, options = {}) {
  return createPostFromPrompt(client, task, buildPostPrompt(task, options), options);
}

async function createReviewedPost(client, task, originalPost, originalReview, options = {}) {
  const originalFingerprint = revisionFingerprint(originalPost);
  for (let attempt = 0; attempt < QUALITY_REVISION_MAX_ATTEMPTS; attempt += 1) {
    const prompt = buildQualityRevisionPrompt(
      task,
      originalPost,
      originalReview,
      options,
      { unchangedRetry: attempt > 0 },
    );
    const reviewed = await createPostFromPrompt(client, task, prompt, options);
    if (revisionFingerprint(reviewed.post) !== originalFingerprint) return reviewed;
  }
  throw new CopyGenerationUnchangedError();
}

/**
 * @param {{
 *   task: { query: string, input?: Record<string, unknown> },
 *   client?: ReturnType<typeof createOpenClawClient>,
 *   systemPrompt?: string,
 *   copyKnowledge?: Array<Record<string, unknown>>,
 *   imageCount?: number | 'auto',
 *   autoReviseOnReject?: boolean,
 *   textReviewEnabled?: boolean,
 *   promptRuntime?: Parameters<typeof withPromptRuntime>[0],
 *   planningCatalog?: Parameters<typeof normalizePlanningCatalog>[0],
 *   now?: () => number,
 *   onStageChange?: (stage: string, details?: Record<string, unknown>) => void | Promise<void>,
 * }} options
 */
export function generateCopy(options) {
  const planningCatalog = options.planningCatalog === undefined ? undefined : normalizePlanningCatalog(options.planningCatalog);
  return withPromptRuntime(options.promptRuntime, () => generateCopyInContext({ ...options, planningCatalog }));
}

async function generateCopyInContext({
  task,
  client = createOpenClawClient(),
  systemPrompt,
  copyKnowledge,
  planningCatalog,
  imageCount = 'auto',
  autoReviseOnReject = false,
  textReviewEnabled = true,
  now = () => performance.now(),
  onStageChange = async () => {},
}) {
  if (typeof now !== 'function') throw new TypeError('copy generation clock must be a function');
  if (typeof onStageChange !== 'function') {
    throw new TypeError('copy generation stage callback must be a function');
  }
  if (typeof autoReviseOnReject !== 'boolean') {
    throw new TypeError('autoReviseOnReject must be a boolean');
  }
  if (typeof textReviewEnabled !== 'boolean') {
    throw new TypeError('textReviewEnabled must be a boolean');
  }
  const startedAt = now();
  const timing = {
    queryReviewMs: 0,
    researchMs: 0,
    originalGenerationMs: 0,
    originalReviewMs: 0,
    reviewedGenerationMs: 0,
    reviewedReviewMs: 0,
    totalMs: 0,
  };
  const sourceTask = normalizedTask(task);
  const queryReviewEnabled = promptPolicy().queryReviewEnabled;
  if (queryReviewEnabled) await onStageChange('QUERY_REVIEW');
  const queryReview = queryReviewEnabled ? await measureModelStage(
    timing,
    'queryReviewMs',
    'QUERY_REVIEW',
    now,
    () => runQueryReview({ client, task: sourceTask }),
  ) : await runQueryReview({ client, task: sourceTask });
  if (queryReview.decision !== 'PASS') {
    throw new CopyGenerationRejectedError('QUERY', queryReview);
  }

  let knowledgeMatch;
  let knowledgeReference;
  if (copyKnowledge !== undefined) {
    await onStageChange('KNOWLEDGE_MATCH');
    const matched = await measureStage(timing, 'knowledgeMatchMs', now, () => matchCopyKnowledge({
      query: sourceTask.query,
      knowledge: copyKnowledge,
      client,
      onProgress: (details) => onStageChange('KNOWLEDGE_MATCH', details),
    }));
    knowledgeMatch = matched.record;
    knowledgeReference = matched.reference;
  }

  let generationTask = sourceTask;
  let researchSnapshot = null;
  if (typeof client.runWebSearch === 'function') {
    await onStageChange('RESEARCH');
    researchSnapshot = await measureStage(
      timing,
      'researchMs',
      now,
      () => createResearchSnapshot({ client, query: sourceTask.query }),
    );
    if (researchSnapshot.status !== 'COMPLETED') {
      throw new CopyGenerationResearchError(researchSnapshot);
    }
    generationTask = attachResearchToTask(sourceTask, researchSnapshot);
  }

  const allowedSources = [...new Set([
    ...(sourceTask.input.referenceUrls ?? []),
    ...(researchSnapshot ? researchSourceUrls(researchSnapshot) : []),
  ])];
  await onStageChange('ORIGINAL_GENERATION');
  const original = await measureModelStage(
    timing,
    'originalGenerationMs',
    'ORIGINAL_GENERATION',
    now,
    () => createLivePost(client, generationTask, {
      systemPrompt,
      knowledgeReference,
      planningCatalog,
      imageCount,
      allowedSources,
    }),
  );
  let reviewed = original;
  let originalTextReview = disabledTextReviewResult();
  let reviewedTextReview = originalTextReview;
  let revisionAttempted = false;
  if (textReviewEnabled) {
    await onStageChange('ORIGINAL_REVIEW');
    originalTextReview = await measureModelStage(
      timing,
      'originalReviewMs',
      'ORIGINAL_REVIEW',
      now,
      () => runTextReview({
        client,
        task: generationTask,
        post: original.post,
        allowedSources,
        editorialInstruction: systemPrompt,
      }),
    );
    reviewedTextReview = originalTextReview;
    if (originalTextReview.decision !== 'PASS' && autoReviseOnReject) {
      revisionAttempted = true;
      await onStageChange('REVIEWED_GENERATION');
      reviewed = await measureModelStage(
        timing,
        'reviewedGenerationMs',
        'REVIEWED_GENERATION',
        now,
        () => createReviewedPost(
          client,
          generationTask,
          original.post,
          originalTextReview,
          { systemPrompt, imageCount, allowedSources, knowledgeReference, planningCatalog },
        ),
      );
      await onStageChange('REVIEWED_REVIEW');
      reviewedTextReview = await measureModelStage(
        timing,
        'reviewedReviewMs',
        'REVIEWED_REVIEW',
        now,
        () => runTextReview({
          client,
          task: generationTask,
          post: reviewed.post,
          allowedSources,
          editorialInstruction: systemPrompt,
        }),
      );
    }
  }
  timing.totalMs = elapsedMilliseconds(now, startedAt);

  return {
    post: reviewed.post,
    model: reviewed.model,
    originalPost: original.post,
    reviewedPost: reviewed.post,
    originalModel: original.model,
    reviewedModel: reviewed.model,
    originalThinking: original.thinking,
    reviewedThinking: reviewed.thinking,
    revisionAttempted,
    researchSnapshot,
    ...(knowledgeMatch ? { knowledgeMatch } : {}),
    timing,
    stageReviews: {
      query: queryReview,
      originalText: originalTextReview,
      reviewedText: reviewedTextReview,
      text: reviewedTextReview,
    },
  };
}

function copyFrom(post) {
  return {
    title: post.title,
    body: normalizeProseLineBreaks(post.body),
    tags: post.tags,
  };
}

function metadataFrom(post) {
  return {
    sources: post.sources,
    expressionReferences: post.expressionReferences,
    riskFlags: post.riskFlags,
    fabricatedExperience: post.fabricatedExperience,
    unverifiedClaims: post.unverifiedClaims,
  };
}

function versionFrom(post, model, thinking, review) {
  return {
    copy: copyFrom(post),
    imagePlan: post.imagePlan,
    metadata: metadataFrom(post),
    model,
    thinking,
    review,
  };
}

export function toCopyGenerationResponse({
  id,
  batchId = null,
  batchName = null,
  query,
  input,
  requestedImageCount,
  post,
  model,
  originalPost = post,
  reviewedPost = post,
  originalModel = model,
  reviewedModel = model,
  originalThinking = null,
  reviewedThinking = originalThinking,
  revisionAttempted: rawRevisionAttempted,
  researchSnapshot,
  knowledgeMatch,
  stageReviews,
  manualReview = null,
  timing = null,
  createdAt,
}) {
  if (!originalPost || typeof originalPost !== 'object'
    || !reviewedPost || typeof reviewedPost !== 'object'
    || !Array.isArray(originalPost.tags) || !Array.isArray(originalPost.imagePlan)
    || !Array.isArray(reviewedPost.tags) || !Array.isArray(reviewedPost.imagePlan)) {
    throw new TypeError('generated post is invalid');
  }
  const reviews = {
    ...stageReviews,
    text: stageReviews?.reviewedText ?? stageReviews?.text,
  };
  const revisionAttempted = typeof rawRevisionAttempted === 'boolean'
    ? rawRevisionAttempted
    : Boolean(timing?.reviewedGenerationMs)
      || JSON.stringify(originalPost) !== JSON.stringify(reviewedPost);
  return {
    ...(id === undefined ? {} : { id }),
    batchId,
    batchName,
    ...(query === undefined ? {} : { query }),
    ...(input === undefined ? {} : { input }),
    ...(requestedImageCount === undefined ? {} : { requestedImageCount }),
    ...(createdAt === undefined ? {} : { createdAt }),
    manualReview,
    original: versionFrom(
      originalPost,
      originalModel,
      originalThinking,
      reviews.originalText ?? reviews.text,
    ),
    reviewed: versionFrom(
      reviewedPost,
      reviewedModel,
      reviewedThinking,
      reviews.reviewedText ?? reviews.text,
    ),
    copy: copyFrom(reviewedPost),
    imagePlan: reviewedPost.imagePlan,
    metadata: metadataFrom(reviewedPost),
    generation: {
      model: reviewedModel,
      originalModel,
      reviewedModel,
      thinking: reviewedThinking,
      originalThinking,
      reviewedThinking,
      revisionAttempted,
      imageCount: reviewedPost.imagePlan.length,
      research: researchSnapshot,
      ...(knowledgeMatch ? { knowledgeMatch } : {}),
      reviews,
      timing,
    },
  };
}
