import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { CopyGenerationUnchangedError, generateCopy, toCopyGenerationResponse } from '../src/copy-generation.mjs';
import { normalizeResearchSnapshot } from '../src/research.mjs';
import { promptPolicy, promptProvenance, withPromptRuntime } from '../src/prompt-runtime.mjs';
import { requestPromptProvenance, withPromptTraceContext } from '../src/prompt-trace-context.mjs';

const STAGE_LABELS = Object.freeze({
  QUERY_REVIEW: '选题审核',
  KNOWLEDGE_MATCH: '优秀案例匹配',
  RESEARCH: '联网资料',
  ORIGINAL_GENERATION: '首稿生成',
  COPY_LENGTH_REPAIR: '正文字数修复',
  COPY_CONTRACT_REPAIR: '文案结构修复',
  ORIGINAL_REVIEW: '首稿审核',
  REVIEWED_GENERATION: '质检修订',
  REVIEWED_REVIEW: '修订复检',
  FINAL_IMAGE_PLAN: '最终配图策划',
});
const INPUT_LIMITS = Object.freeze({ category: 100, targetAudience: 200, referenceText: 12_000 });
const TRACE_TEXT_LIMIT = 200_000;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function elapsed(now, startedAt) {
  const result = Number(now()) - Number(startedAt);
  return Number.isFinite(result) ? Math.max(0, Math.round(result)) : 0;
}

function redact(value, secrets) {
  if (typeof value === 'string') {
    return secrets.reduce((text, secret) => secret.length >= 4
      ? text.replaceAll(secret, '[REDACTED_API_KEY]') : text, value);
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, redact(item, secrets)]));
  return value;
}

function referenceUrls(value = []) {
  if (!Array.isArray(value) || value.length > 8) throw new TypeError('参考链接最多填写 8 条');
  return [...new Set(value.map((item) => {
    if (typeof item !== 'string' || item.length > 500) throw new TypeError('参考链接格式不正确');
    let url;
    try { url = new URL(item.trim()); } catch { throw new TypeError('参考链接格式不正确'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new TypeError('参考链接必须是 HTTP 或 HTTPS 链接');
    }
    return url.href;
  }))];
}

function boundedInput(raw = {}) {
  if (!isRecord(raw)) throw new TypeError('文案输入格式不正确');
  const input = {};
  for (const [name, limit] of Object.entries(INPUT_LIMITS)) {
    if (raw[name] === undefined || raw[name] === '') continue;
    if (typeof raw[name] !== 'string' || [...raw[name]].length > limit) {
      throw new RangeError(`${name} 内容过长或格式不正确`);
    }
    input[name] = raw[name].trim();
  }
  input.referenceUrls = referenceUrls(raw.referenceUrls);
  return input;
}

function inputFromRequest(body) {
  if (body.input !== undefined && !isRecord(body.input)) throw new TypeError('文案输入格式不正确');
  const input = { ...(isRecord(body.requirements) ? body.requirements : {}), ...(body.input ?? {}) };
  if (typeof body.requirements === 'string' && body.requirements.trim()) {
    input.referenceText = [input.referenceText, body.requirements.trim()].filter(Boolean).join('\n\n');
  } else if (body.requirements != null && typeof body.requirements !== 'string' && !isRecord(body.requirements)) {
    throw new TypeError('文案补充要求格式不正确');
  }
  return boundedInput(input);
}

/** Validate only writing inputs. Model credentials are handled by the server. */
export function validateGenerateRequest(body) {
  if (!isRecord(body)) throw new TypeError('文案生成请求格式不正确');
  const query = typeof body.query === 'string' ? body.query.replace(/\s+/gu, ' ').trim() : '';
  if (!query || [...query].length > 500) throw new RangeError('Query 需要 1–500 个字符');
  const imageCount = body.requestedImageCount ?? body.imageCount ?? 'auto';
  if (imageCount !== 'auto' && (!Number.isInteger(imageCount) || imageCount < 3 || imageCount > 5)) {
    throw new RangeError('配图数量需为自动或 3–5 页');
  }
  const textReviewEnabled = body.textReviewEnabled ?? true;
  const autoReviseOnReject = body.autoReviseOnReject ?? true;
  if (typeof textReviewEnabled !== 'boolean' || typeof autoReviseOnReject !== 'boolean') {
    throw new TypeError('文案审核与自动修订选项需为布尔值');
  }
  const suppliedResearch = body.researchSnapshot ?? body.research?.snapshot ?? body.research ?? null;
  const researchSnapshot = suppliedResearch == null ? null
    : normalizeResearchSnapshot(suppliedResearch);
  if (researchSnapshot && (researchSnapshot.status !== 'COMPLETED'
    || researchSnapshot.query.replace(/\s+/gu, ' ').trim() !== query)) {
    throw new TypeError('只能使用当前 Query 已成功完成的搜索资料生成文案');
  }
  return { query, input: inputFromRequest(body), imageCount, textReviewEnabled,
    autoReviseOnReject, researchSnapshot };
}

function tracedText(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return { text: text.slice(0, TRACE_TEXT_LIMIT), sha256: sha256(text),
    characterCount: text.length, truncated: text.length > TRACE_TEXT_LIMIT };
}

function generationError(error, currentStage) {
  return {
    name: typeof error?.name === 'string' ? error.name : 'Error',
    message: String(error?.message ?? '文案生成失败').slice(0, 2_000),
    stage: error?.stage ?? currentStage ?? null,
    ...(typeof error?.code === 'string' ? { code: error.code } : {}),
    ...(isRecord(error?.review) ? { review: error.review } : {}),
  };
}

function retainedUnchangedResponse(error, request) {
  if (!(error instanceof CopyGenerationUnchangedError) || !isRecord(error.partialResult)) return null;
  const generated = error.partialResult;
  const validPost = (value) => isRecord(value) && typeof value.title === 'string'
    && typeof value.body === 'string' && Array.isArray(value.tags)
    && value.tags.every((tag) => typeof tag === 'string')
    && Array.isArray(value.imagePlan) && value.imagePlan.length >= 3 && value.imagePlan.length <= 5
    && value.imagePlan.every(isRecord);
  if (![generated.post, generated.originalPost, generated.reviewedPost].every(validPost)
    || generated.revisionAttempted !== true
    || generated.stageReviews?.originalText?.decision !== 'REJECT'
    || generated.stageReviews?.text?.decision !== 'REJECT'
    || generated.stageReviews?.reviewedText !== null) return null;
  try {
    const response = toCopyGenerationResponse({ query: request.query, input: request.input,
      requestedImageCount: request.imageCount, ...generated });
    // The last attempted draft was not reviewed again, so it has no final review.
    response.reviewed.review = null;
    return { generated, response };
  } catch {
    return null;
  }
}

/**
 * Reuse the production writing pipeline and its rendered prompts, without
 * persisting test content, generating images, or creating production tasks.
 * The server supplies the configured client and pinned prompt runtime.
 */
export async function generateLabCopy(body, {
  client,
  promptRuntime,
  systemPrompt,
  copyKnowledge = [],
  now = () => performance.now(),
  onStageChange = async () => {},
  secrets = [],
} = {}) {
  const request = validateGenerateRequest(body);
  if (typeof client?.runText !== 'function') throw new TypeError('请先配置文案生成模型');
  if (!Array.isArray(copyKnowledge)) throw new TypeError('优秀案例配置格式不正确');
  if (typeof now !== 'function' || typeof onStageChange !== 'function') {
    throw new TypeError('文案生成阶段配置格式不正确');
  }
  const secretValues = secrets.filter((value) => typeof value === 'string' && value);
  const startedAt = now();
  const stages = [];
  const promptTrace = [];
  let currentStage = null;
  let activeStage = null;

  function completeStage(status = 'COMPLETED') {
    if (!activeStage || activeStage.status !== 'RUNNING') return;
    activeStage.status = status;
    activeStage.durationMs = elapsed(now, activeStage.startedAt);
    delete activeStage.startedAt;
  }

  async function reportStage(stage, details = {}) {
    if (stage === 'RESEARCH' && request.researchSnapshot) details = {
      ...details, reused: true, provider: request.researchSnapshot.provider,
      searchedAt: request.researchSnapshot.searchedAt, sourceCount: request.researchSnapshot.sources.length,
    };
    if (activeStage?.id !== stage || stage.startsWith('COPY_')) {
      completeStage();
      currentStage = stage;
      activeStage = { id: stage, stage, label: STAGE_LABELS[stage] ?? stage,
        status: 'RUNNING', durationMs: 0, startedAt: now(), details };
      stages.push(activeStage);
    } else {
      activeStage.details = { ...activeStage.details, ...details };
    }
    await onStageChange(stage, redact(details, secretValues));
  }

  function skippedStage(stage, reason) {
    stages.push({ id: stage, stage, label: STAGE_LABELS[stage],
      status: 'SKIPPED', durationMs: 0, details: { reason } });
  }

  async function traceModelCall(method, input) {
    const callStartedAt = now();
    const prompt = tracedText(input.prompt);
    const trace = { index: promptTrace.length + 1, stage: currentStage,
      label: STAGE_LABELS[currentStage] ?? currentStage, method,
      prompt: prompt.text, promptSha256: prompt.sha256,
      promptCharacterCount: prompt.characterCount, promptTruncated: prompt.truncated,
      provenance: requestPromptProvenance(input.prompt),
      ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
      thinking: input.thinking ?? null, status: 'RUNNING', durationMs: 0 };
    promptTrace.push(trace);
    try {
      const generated = await client[method](input);
      const output = tracedText(generated?.rawText);
      Object.assign(trace, { status: 'COMPLETED', rawOutput: output.text,
        outputSha256: output.sha256, outputCharacterCount: output.characterCount,
        outputTruncated: output.truncated, model: generated?.model ?? null,
        thinking: generated?.thinking ?? trace.thinking });
      return generated;
    } catch (error) {
      Object.assign(trace, { status: 'FAILED', error: generationError(error, currentStage) });
      throw error;
    } finally {
      trace.durationMs = elapsed(now, callStartedAt);
    }
  }

  const tracedClient = { ...client, runText: (input) => traceModelCall('runText', input) };
  if (typeof client.runReview === 'function') {
    tracedClient.runReview = (input) => traceModelCall('runReview', input);
  }

  return withPromptRuntime(promptRuntime, () => withPromptTraceContext(promptRuntime, async () => {
    if (!promptPolicy().queryReviewEnabled) skippedStage('QUERY_REVIEW', '当前系统已关闭选题审核');
    try {
      const generated = await generateCopy({
        task: { query: request.query, input: request.input },
        client: tracedClient,
        systemPrompt,
        copyKnowledge,
        imageCount: request.imageCount,
        autoReviseOnReject: request.autoReviseOnReject,
        textReviewEnabled: request.textReviewEnabled,
        researchSnapshot: request.researchSnapshot,
        now,
        onStageChange: reportStage,
      });
      completeStage();
      const knowledgeStage = stages.find(({ id }) => id === 'KNOWLEDGE_MATCH');
      if (knowledgeStage && generated.knowledgeMatch) knowledgeStage.details = {
        ...knowledgeStage.details, status: generated.knowledgeMatch.status,
        candidateCount: generated.knowledgeMatch.candidateCount,
        selectedItemId: generated.knowledgeMatch.selectedItemId,
        selectedScore: generated.knowledgeMatch.selectedScore,
      };
      if (!request.textReviewEnabled) skippedStage('ORIGINAL_REVIEW', '本次已关闭自动文案审核');
      if (!generated.revisionAttempted) {
        skippedStage('REVIEWED_GENERATION', request.autoReviseOnReject
          ? '首稿无需质检修订' : '本次已关闭自动修订');
        skippedStage('REVIEWED_REVIEW', '没有质检修订版本');
      }
      stages.push({ id: 'FINAL_IMAGE_PLAN', stage: 'FINAL_IMAGE_PLAN', label: STAGE_LABELS.FINAL_IMAGE_PLAN,
        status: 'COMPLETED', durationMs: 0, details: {
          imageCount: generated.post.imagePlan.length, source: '最终文案内的配图策划',
        } });
      const response = toCopyGenerationResponse({ query: request.query, input: request.input,
        requestedImageCount: request.imageCount, ...generated });
      return redact({ schemaVersion: 1, status: 'COMPLETED', ...response,
        post: generated.post, review: generated.stageReviews?.text ?? null,
        qualityStatus: generated.stageReviews?.text?.skipped ? 'SKIPPED'
          : generated.stageReviews?.text?.decision ?? null,
        stageReviews: generated.stageReviews,
        researchSnapshot: generated.researchSnapshot, stages, promptTrace, prompts: promptTrace,
        promptProvenance: promptProvenance(), durationMs: elapsed(now, startedAt) }, secretValues);
    } catch (error) {
      completeStage('FAILED');
      const failure = generationError(error, currentStage);
      const retained = retainedUnchangedResponse(error, request);
      if (retained) {
        const { generated, response } = retained;
        skippedStage('REVIEWED_REVIEW', '两次修订未产生实际修改，没有执行修订复检');
        stages.push({ id: 'FINAL_IMAGE_PLAN', stage: 'FINAL_IMAGE_PLAN', label: STAGE_LABELS.FINAL_IMAGE_PLAN,
          status: 'COMPLETED', durationMs: 0, details: {
            imageCount: generated.post.imagePlan.length, source: '保留文案内的配图策划',
          } });
        return redact({ schemaVersion: 1, status: 'REJECTED', ...response,
          post: generated.post, review: generated.stageReviews.text, qualityStatus: 'REJECT',
          revisionUnchanged: true, revisionFailed: true,
          revisionAttempts: generated.revisionAttempts,
          generation: { ...response.generation, revisionUnchanged: true, revisionFailed: true,
            revisionAttempts: generated.revisionAttempts },
          stageReviews: generated.stageReviews, researchSnapshot: generated.researchSnapshot,
          error: { ...failure, message: '修订未产生实际修改，已保留原稿和审核意见' },
          stages, promptTrace, prompts: promptTrace, promptProvenance: promptProvenance(),
          durationMs: elapsed(now, startedAt) }, secretValues);
      }
      return redact({ schemaVersion: 1,
        status: error?.name === 'CopyGenerationRejectedError' ? 'REJECTED' : 'FAILED',
        query: request.query, post: null, copy: null, imagePlan: [],
        review: error?.review ?? null,
        researchSnapshot: error?.snapshot ?? request.researchSnapshot,
        stageReviews: error?.review ? {
          [error.stage === 'QUERY' ? 'query' : 'text']: error.review,
        } : {},
        error: failure, stages, promptTrace, prompts: promptTrace, promptProvenance: promptProvenance(),
        durationMs: elapsed(now, startedAt) }, secretValues);
    }
  }));
}
