import { constants, existsSync } from 'node:fs';
import { withModelCallTracing } from '../model-call-trace.mjs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { access, mkdir, readFile, rm } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';

import { createCopyGenerationClient } from '../copy-generation-client.mjs';
import { effectiveModelApiConfig } from '../model-api-config.mjs';
import { codexErrorCode } from '../codex-protocol.mjs';
import { codexRuntimePath, createCodexRuntime } from '../codex-runtime.mjs';
import { generateCopy, toCopyGenerationResponse } from '../copy-generation.mjs';
import { createAgentClient as createOpenClawClient } from '../agent-client.mjs';
import { generateStandaloneImages, normalizeStandaloneImageSource, retryStandaloneImageRun, standaloneImageRunDirectory } from '../standalone-image-generation.mjs';
import { plannedForStandaloneRecovery } from '../standalone-image-recovery.mjs';
import { findImageRecoveryRun, imageRecoveryRunIds, loadUploadedImages, readCheckpoint, saveCheckpoint } from './image-checkpoints.mjs';
import { executorConcurrency } from './config.mjs';
import { reprocessStandaloneImages } from '../standalone-image-generation.mjs';
import { IMAGE_ARTIFACT_FILE } from '../image-artifacts.mjs';
import { guardExecutionCalls, runWithExecutionSignal } from './execution-signal.mjs';

const COPY_PROGRESS = Object.freeze({
  QUERY_REVIEW: 5,
  KNOWLEDGE_MATCH: 12,
  RESEARCH: 20,
  ORIGINAL_GENERATION: 45,
  ORIGINAL_REVIEW: 70,
  REVIEWED_GENERATION: 80,
  REVIEWED_REVIEW: 92,
});

export function productionSettings(snapshot) {
  const settings = snapshot.productionSettings?.production?.value ?? {};
  return typeof snapshot.task?.aiDisclosureEnabled === 'boolean'
    ? { ...settings, aiDisclosureEnabled: snapshot.task.aiDisclosureEnabled }
    : settings;
}

function publishedPrompt(snapshot, kind) {
  const prompt = snapshot.prompts?.[kind];
  if (!prompt?.content) throw new Error(`published ${kind} prompt is unavailable on control plane`);
  return prompt.content;
}

function visualReference(snapshot) {
  return snapshot.knowledge
    .filter((item) => item.kind === 'VISUAL')
    .map((item) => item.content)
    .filter((content) => content && typeof content === 'object')
    .filter((content) => !content.generationTarget || content.generationTarget === 'MODEL_IMAGE')
    .sort((left, right) => Number(right.qualityScore ?? 0) - Number(left.qualityScore ?? 0))[0]
    ?? null;
}

function safeTaskWorkRoot(baseRoot, rawTaskId) {
  const taskId = Number(rawTaskId);
  if (!Number.isSafeInteger(taskId) || taskId < 1) throw new TypeError('task id is invalid');
  const root = resolve(baseRoot);
  const path = resolve(root, String(taskId));
  const relation = relative(root, path);
  if (!relation || relation.startsWith('..')) throw new Error('task work path escaped executor root');
  return path;
}

function copySource(revision) {
  const content = revision?.content;
  if (!content || typeof content !== 'object') throw new Error('approved copy revision is unavailable');
  const copy = content.copy ?? content.reviewed?.copy ?? content.post;
  const imagePlan = content.imagePlan ?? content.reviewed?.imagePlan ?? content.post?.imagePlan;
  if (!copy || !Array.isArray(imagePlan)) throw new Error('approved copy revision is incomplete');
  return { query: content.query ?? revision.query, copy, imagePlan,
    ...(content.imageSettings ? { imageSettings: content.imageSettings } : {}) };
}

export async function checkExecutorReady({
  controlPlane,
  workRoot,
  environment = process.env,
  modelClient,
}) {
  const health = await controlPlane.health();
  if (!health?.ok) throw new Error('中心服务尚未准备完成');
  await mkdir(workRoot, { recursive: true });
  await access(workRoot, constants.R_OK | constants.W_OK);
  const records = await controlPlane.listSettings?.();
  const modelApi = records?.find((record) => record.key === 'production')?.value?.modelApi ?? {};
  if (effectiveModelApiConfig(modelApi, environment).agentProvider === 'CODEX' && !health.capabilities?.executionRetryControl) {
    throw new Error('使用 Codex 前请更新并重启中心服务：缺少 executionRetryControl，无法保证失败后不重复生成');
  }
  (modelClient ?? createOpenClawClient({ modelApi, environment })).checkReady();
  return { health, workRoot };
}

async function checkModelAvailability({ environment, controlPlane }) {
  const path = codexRuntimePath(environment);
  if (!existsSync(path)) return;
  const limits = createCodexRuntime({ databasePath: path });
  if (!limits.status().code) return;
  const records = await controlPlane.listSettings?.();
  const modelApi = records?.find((record) => record.key === 'production')?.value?.modelApi ?? {};
  if (effectiveModelApiConfig(modelApi, environment).agentProvider === 'CODEX') limits.assertAvailable();
}

export async function executeCopyClaim({ claim, controlPlane, environment = process.env, client, signal }) {
  const { execution } = claim;
  const snapshot = execution.snapshot;
  const settings = productionSettings(snapshot);
  const modelClient = client ?? createCopyGenerationClient({ modelApi: settings.modelApi ?? {}, environment });
  const generated = await generateCopy({
    client: signal ? guardExecutionCalls(modelClient, signal, { model: true }) : modelClient,
    task: snapshot.task,
    copyKnowledge: snapshot.knowledge ?? [],
    systemPrompt: publishedPrompt(snapshot, 'TEXT_SYSTEM'),
    promptRuntime: promptRuntimeFromSnapshot(snapshot),
    imageCount: snapshot.task.requestedImageCount,
    autoReviseOnReject: false,
    textReviewEnabled: false,
    onStageChange: async (stage, details = {}) => controlPlane.updateProgress(execution.id, {
      stage,
      progressPercent: COPY_PROGRESS[stage] ?? 0,
      message: stage === 'KNOWLEDGE_MATCH' ? '正在匹配优秀文案案例' : `正在执行文案阶段：${stage}`,
      details,
    }),
  });
  const result = toCopyGenerationResponse({
    query: snapshot.task.query,
    input: snapshot.task.input,
    requestedImageCount: snapshot.task.requestedImageCount,
    ...generated,
  });
  return controlPlane.completeCopy(execution.id, result);
}

export async function executeImageClaim({
  claim,
  controlPlane,
  workRoot,
  imageClient,
  environment = process.env,
  signal,
}) {
  const { execution, task } = claim;
  const snapshot = execution.snapshot;
  const settings = productionSettings(snapshot);
  const taskRoot = safeTaskWorkRoot(workRoot, task.id);
  const source = copySource(snapshot.copyRevision);
  if (!source.query) source.query = snapshot.task.query;
  const recoveryRunIds = imageRecoveryRunIds(execution, taskRoot);
  let sourceRunId = null;
  const restorePlan = storedPlan => plannedForStandaloneRecovery({
    storedPlan, post: normalizeStandaloneImageSource(source),
    normalizeNotice: value => typeof value === 'string' ? value.slice(0, 1000) : null,
  });
  if (recoveryRunIds.length > 0) {
    try {
      sourceRunId = await findImageRecoveryRun(taskRoot, recoveryRunIds);
      if (snapshot.visualPlanCheckpoint) {
        const localPlan = restorePlan(await readCheckpoint(join(standaloneImageRunDirectory(taskRoot, sourceRunId), 'visual-plan.json')));
        if (!isDeepStrictEqual(localPlan.visualPlan, restorePlan(snapshot.visualPlanCheckpoint).visualPlan)) sourceRunId = null;
      }
    } catch (error) {
      if (!snapshot.visualPlanCheckpoint) throw error;
      sourceRunId = null;
    }
  }
  const local = snapshot.copyRevision.content.imageReprocess;
  const centralRecovery = !local && !sourceRunId && snapshot.visualPlanCheckpoint ? {
    planned: restorePlan(snapshot.visualPlanCheckpoint),
  } : null;
  const generate = local ? reprocessStandaloneImages : sourceRunId ? retryStandaloneImageRun : generateStandaloneImages;
  const result = await generate({
    signal,
    source,
    mode: 'LIVE',
    outputRoot: taskRoot,
    runId: execution.id,
    ...(local ? {
      originalResult: local.originalResult,
      originalAvailable: local.sources.every(item => item.originalAvailable),
      loadSource: async (_image, index) => {
        const pinned = local.sources[index];
        const bytes = await controlPlane.downloadImageSource(execution.id, pinned.assetId);
        if (createHash('sha256').update(bytes).digest('hex') !== pinned.sha256) throw new Error('原图片校验失败，请检查中心资产');
        return bytes;
      },
    } : sourceRunId ? { sourceRunId, expectedSource: source, allowInterrupted: true } : centralRecovery ? { recovery: centralRecovery } : {}),
    runtime: local ? undefined : {
      productionSettings: settings,
      imageSystemPrompt: publishedPrompt(snapshot, 'IMAGE_SYSTEM'),
      promptRuntime: promptRuntimeFromSnapshot(snapshot),
      visualReference: visualReference(snapshot),
      client: imageClient ?? createOpenClawClient({ modelApi: settings.modelApi ?? {}, environment }),
    },
    onProgress: async (progress) => controlPlane.updateProgress(execution.id, {
      stage: progress.stage,
      progressPercent: progress.progressPercent,
      message: progress.message,
      details: {
        completedImages: progress.completedImages,
        generatedImages: progress.generatedImages,
        validatedImages: progress.validatedImages,
        currentPage: progress.currentPage,
        attempt: progress.attempt,
      },
    }),
    onVisualPlan: settings.layoutCatalog && controlPlane.saveVisualPlan ? (plan) => controlPlane.saveVisualPlan(execution.id, plan) : undefined,
  });
  const outputDirectory = standaloneImageRunDirectory(taskRoot, execution.id);
  const uploads = centralRecovery ? {} : await loadUploadedImages(taskRoot, recoveryRunIds);
  await controlPlane.updateProgress(execution.id, {
    stage: 'UPLOADING', progressPercent: 97, message: '正在上传已生成的图片', details: {},
  });
  const uploadedImages = [];
  async function upload(fileName, mediaType) {
    if (basename(fileName) !== fileName || !IMAGE_ARTIFACT_FILE.test(fileName)) {
      throw new Error('generated image file name is invalid');
    }
    const content = await readFile(join(outputDirectory, fileName));
    const sha256 = createHash('sha256').update(content).digest('hex');
    const asset = uploads[fileName]?.sha256 === sha256
      && (!result.imageControlsVersion || uploads[fileName].asset.imageRunId === execution.id)
      ? uploads[fileName].asset
      : await controlPlane.uploadAsset(execution.id, { content, mediaType, fileName });
    uploads[fileName] = { sha256, asset };
    await saveCheckpoint(join(outputDirectory, 'uploads.json'), uploads);
    return asset;
  }
  for (const image of result.images) {
    const asset = await upload(image.file, 'image/png');
    let artifacts = {};
    if (image.imageSettings) {
      const original = await upload(image.sourceFile, 'image/png');
      const delivery = image.deliveryFile === image.file ? asset : await upload(image.deliveryFile, image.mediaType);
      artifacts = { sourceAssetId: original.id, sourceUrl: original.url, deliveryAssetId: delivery.id, deliveryUrl: delivery.url };
    }
    uploadedImages.push({ ...image, ...artifacts, assetId: asset.id, url: asset.url });
  }
  await controlPlane.updateProgress(execution.id, {
    stage: 'FINALIZING', progressPercent: 99, message: '图片已上传，正在保存交付结果', details: {},
  });
  const completed = await controlPlane.completeImage(execution.id, {
    ...result,
    images: uploadedImages,
  });
  // Another execution may already use this task root when the completion response arrives.
  // Keep other runs/recovery checkpoints; cleanup cannot fail an accepted delivery.
  await rm(outputDirectory, { recursive: true, force: true }).catch(() => {});
  return completed;
}

export function createExecutorAgent({
  controlPlane,
  nodeId,
  nodeName = nodeId,
  imageWorkerEnabled = false,
  copyConcurrency = 1,
  imageConcurrency = 1,
  concurrencyEnabled = false,
  workRoot = resolve('data/executor-work'),
  executeCopy = executeCopyClaim,
  executeImage = executeImageClaim,
  readinessCheck = checkExecutorReady,
  availabilityCheck = checkModelAvailability,
  environment = process.env,
  now = Date.now,
}) {
  if (!controlPlane) throw new TypeError('controlPlane client is required');
  if (typeof imageWorkerEnabled !== 'boolean') throw new TypeError('imageWorkerEnabled must be a boolean');
  executorConcurrency(copyConcurrency, 'copyConcurrency');
  executorConcurrency(imageConcurrency, 'imageConcurrency');
  let ready = false;
  const pendingFailures = new Map();
  const activeExecutions = new Map();
  const executionLeases = new Map();
  let taskHeartbeatsEnabled = false;

  async function renewExecutionHeartbeats(ids = [...executionLeases.keys()].filter(id => !pendingFailures.has(id))) {
    if (!taskHeartbeatsEnabled || !ids.length) return;
    try {
      const response = await controlPlane.heartbeatExecutions({ nodeId, executionIds: ids });
      for (const id of response.activeExecutionIds) {
        const lease = executionLeases.get(id);
        if (lease) lease.acknowledgedAt = now();
      }
      for (const id of response.staleExecutionIds) {
        executionLeases.get(id)?.controller.abort(Object.assign(new Error('中心已结束或回收此执行，已停止本机后续调用'), { code: 'STALE_EXECUTION' }));
      }
    } finally {
      for (const id of ids) {
        const lease = executionLeases.get(id);
        if (lease && now() - lease.acknowledgedAt >= 120_000) {
          lease.controller.abort(Object.assign(new Error('超过2分钟未确认任务心跳，执行结果未确认；已停止本机后续调用'), { code: 'EXECUTION_HEARTBEAT_LOST' }));
        }
      }
    }
  }

  async function reportFailure(claim, error) {
    try {
      const code = codexErrorCode(error) || error?.code?.startsWith('EXECUTION_') || error?.code === 'STALE_EXECUTION';
      await controlPlane.failExecution(claim.execution.id, error,
        code ? { autoRetry: false } : {});
    } catch (reportError) {
      if (reportError?.code !== 'STALE_EXECUTION') throw reportError;
    }
  }

  async function finishFailure(kind, { claim, error }) {
    await reportFailure(claim, error);
    pendingFailures.delete(claim.execution.id);
    return {
      kind,
      taskId: claim.task.id,
      executionId: claim.execution.id,
      status: error?.code === 'STALE_EXECUTION' ? 'ABANDONED' : 'FAILED',
      error,
    };
  }

  async function availability(kind) {
    if (!ready) throw new Error('executor is not ready; call prepare before claiming work');
    try { await availabilityCheck({ environment, controlPlane }); }
    catch (error) {
      if (!codexErrorCode(error)) throw error;
      return { kind, status: 'PAUSED', code: codexErrorCode(error), retryAt: error.retryAt ?? null };
    }
    return null;
  }

  async function claimAndExecute(kind) {
    if (!ready) throw new Error('executor is not ready; call prepare before claiming work');
    if (kind === 'IMAGE' && !imageWorkerEnabled) return null;
    const pending = [...pendingFailures.values()].find(failure => failure.kind === kind);
    if (pending) return executeClaim(kind, pending.claim);
    const paused = await availability(kind);
    if (paused) return paused;
    const claim = kind === 'COPY'
      ? await controlPlane.claimCopy(nodeId)
      : await controlPlane.claimImage(nodeId);
    if (!claim) return null;
    return executeClaim(kind, claim);
  }

  async function performClaim(kind, claim) {
    const pending = pendingFailures.get(claim.execution.id);
    if (pending) return finishFailure(kind, pending);
    if (claim.execution.status && claim.execution.status !== 'RUNNING') {
      return { kind, taskId: claim.task.id, executionId: claim.execution.id, status: 'ABANDONED' };
    }
    const { signal } = executionLeases.get(claim.execution.id).controller;
    try {
      await renewExecutionHeartbeats([claim.execution.id]);
      await runWithExecutionSignal(signal, () => withModelCallTracing({ executionId: claim.execution.id,
        controlPlane: guardExecutionCalls(controlPlane, signal), snapshot: claim.execution.snapshot }, async (tracedPlane) => {
        if (kind === 'COPY') {
          await executeCopy({ claim, controlPlane: tracedPlane, environment, signal });
        } else {
          await executeImage({ claim, controlPlane: tracedPlane, workRoot, environment, signal });
        }
      }));
      return { kind, taskId: claim.task.id, executionId: claim.execution.id, status: 'SUCCEEDED' };
    } catch (error) {
      if (signal.aborted) error = signal.reason;
      const failure = { kind, claim, error };
      pendingFailures.set(claim.execution.id, failure);
      return finishFailure(kind, failure);
    }
  }

  function executeClaim(kind, claim) {
    if (!ready) return Promise.reject(new Error('executor is not ready; call prepare before execution'));
    if (!['COPY', 'IMAGE'].includes(kind) || (kind === 'IMAGE' && !imageWorkerEnabled)) {
      return Promise.reject(new Error('execution kind is not enabled'));
    }
    const id = claim.execution.id;
    if (activeExecutions.has(id)) return activeExecutions.get(id);
    executionLeases.set(id, { controller: new AbortController(), acknowledgedAt: now() });
    const running = Promise.resolve().then(() => performClaim(kind, claim))
      .finally(() => { activeExecutions.delete(id); executionLeases.delete(id); });
    activeExecutions.set(id, running);
    return running;
  }

  return {
    async prepare() {
      const result = await readinessCheck({
        controlPlane,
        nodeId,
        nodeName,
        imageWorkerEnabled,
        workRoot,
        environment,
      });
      if (concurrencyEnabled && !result?.health?.capabilities?.executorConcurrency) {
        throw new Error('请先更新中心服务：缺少 executorConcurrency 并发领取能力');
      }
      taskHeartbeatsEnabled = Boolean(result?.health?.capabilities?.executionHeartbeats);
      ready = true;
      return result;
    },

    async register() {
      if (!ready) throw new Error('executor is not ready; call prepare before register');
      return controlPlane.registerNode({ nodeId, name: nodeName, imageWorkerEnabled, copyConcurrency, imageConcurrency });
    },

    async heartbeat() {
      if (!ready) throw new Error('executor is not ready; call prepare before heartbeat');
      // A failed node heartbeat must not prevent local task lease expiry checks.
      const results = await Promise.allSettled([
        controlPlane.registerNode({ nodeId, name: nodeName, imageWorkerEnabled, copyConcurrency, imageConcurrency }),
        renewExecutionHeartbeats(),
      ]);
      for (const result of results) if (result.status === 'rejected') throw result.reason;
      return results[0].value;
    },

    async claimBatch(kind, { limit, requestId, reconcile = false }) {
      if (!ready) throw new Error('executor is not ready; call prepare before claiming work');
      if (kind === 'IMAGE' && !imageWorkerEnabled) return { requestId, claims: [] };
      if (!['COPY', 'IMAGE'].includes(kind)) throw new TypeError('invalid execution kind');
      // An uncertain claim may already own work. Reconcile it even while models are paused.
      const paused = reconcile ? null : await availability(kind);
      if (paused) return paused;
      return kind === 'COPY'
        ? controlPlane.claimCopyBatch({ nodeId, limit, requestId })
        : controlPlane.claimImageBatch({ nodeId, limit, requestId });
    },
    executeClaim,

    runCopyOnce: () => claimAndExecute('COPY'),
    runImageOnce: () => claimAndExecute('IMAGE'),
  };
}
import { promptRuntimeFromSnapshot } from '../admin/prompt-runtime-service.mjs';
