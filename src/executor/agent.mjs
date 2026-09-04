import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rm } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';

import { createCopyGenerationClient } from '../copy-generation-client.mjs';
import { generateCopy, toCopyGenerationResponse } from '../copy-generation.mjs';
import { createOpenClawClient } from '../openclaw.mjs';
import { generateStandaloneImages, retryStandaloneImageRun, standaloneImageRunDirectory } from '../standalone-image-generation.mjs';
import { findImageRecoveryRun, imageRecoveryRunIds, loadUploadedImages, saveCheckpoint } from './image-checkpoints.mjs';

const COPY_PROGRESS = Object.freeze({
  QUERY_REVIEW: 5,
  RESEARCH: 20,
  ORIGINAL_GENERATION: 45,
  ORIGINAL_REVIEW: 70,
  REVIEWED_GENERATION: 80,
  REVIEWED_REVIEW: 92,
});

function productionSettings(snapshot) {
  return snapshot.productionSettings?.production?.value ?? {};
}

function publishedPrompt(snapshot, kind) {
  const prompt = snapshot.prompts?.[kind];
  if (!prompt?.content) throw new Error(`published ${kind} prompt is unavailable on control plane`);
  return prompt.content;
}

function copyKnowledgeText(snapshot) {
  const sections = snapshot.knowledge
    .filter((item) => item.kind === 'COPY')
    .map((item) => {
      if (typeof item.content === 'string') return item.content;
      if (typeof item.content?.text === 'string') return item.content.text;
      if (typeof item.content?.summary === 'string') return item.content.summary;
      return '';
    })
    .filter(Boolean);
  return sections.join('\n\n').slice(0, 8_000);
}

function taskWithKnowledge(task, snapshot) {
  const knowledge = copyKnowledgeText(snapshot);
  if (!knowledge) return task;
  const existing = String(task.input?.referenceText ?? '').trim();
  return {
    ...task,
    input: {
      ...task.input,
      referenceText: [existing, `中心知识库：\n${knowledge}`].filter(Boolean).join('\n\n').slice(0, 12_000),
    },
  };
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
  return { query: content.query ?? revision.query, copy, imagePlan };
}

export async function checkExecutorReady({
  controlPlane,
  workRoot,
}) {
  const health = await controlPlane.health();
  if (!health?.ok) throw new Error('中心服务尚未准备完成');
  await mkdir(workRoot, { recursive: true });
  await access(workRoot, constants.R_OK | constants.W_OK);
  return { health, workRoot };
}

export async function executeCopyClaim({ claim, controlPlane, environment = process.env }) {
  const { execution, task } = claim;
  const snapshot = execution.snapshot;
  const settings = productionSettings(snapshot);
  const client = createCopyGenerationClient({ modelApi: settings.modelApi ?? {}, environment });
  const sourceTask = taskWithKnowledge(snapshot.task, snapshot);
  const generated = await generateCopy({
    client,
    task: sourceTask,
    systemPrompt: publishedPrompt(snapshot, 'TEXT_SYSTEM'),
    imageCount: snapshot.task.requestedImageCount,
    autoReviseOnReject: false,
    textReviewEnabled: false,
    onStageChange: async (stage) => controlPlane.updateProgress(execution.id, {
      stage,
      progressPercent: COPY_PROGRESS[stage] ?? 0,
      message: `正在执行文案阶段：${stage}`,
      details: {},
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
}) {
  const { execution, task } = claim;
  const snapshot = execution.snapshot;
  const settings = productionSettings(snapshot);
  const taskRoot = safeTaskWorkRoot(workRoot, task.id);
  const source = copySource(snapshot.copyRevision);
  if (!source.query) source.query = snapshot.task.query;
  const recoveryRunIds = imageRecoveryRunIds(execution, taskRoot);
  const sourceRunId = recoveryRunIds.length > 0
    ? await findImageRecoveryRun(taskRoot, recoveryRunIds)
    : null;
  const generate = sourceRunId ? retryStandaloneImageRun : generateStandaloneImages;
  const result = await generate({
    source,
    mode: 'LIVE',
    outputRoot: taskRoot,
    runId: execution.id,
    ...(sourceRunId ? { sourceRunId, expectedSource: source, allowInterrupted: true } : {}),
    runtime: {
      productionSettings: settings,
      imageSystemPrompt: publishedPrompt(snapshot, 'IMAGE_SYSTEM'),
      visualReference: visualReference(snapshot),
      client: imageClient ?? createOpenClawClient({ modelApi: settings.modelApi ?? {} }),
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
  });
  const outputDirectory = standaloneImageRunDirectory(taskRoot, execution.id);
  const uploads = await loadUploadedImages(taskRoot, recoveryRunIds);
  await controlPlane.updateProgress(execution.id, {
    stage: 'UPLOADING', progressPercent: 97, message: '正在上传已生成的图片', details: {},
  });
  const uploadedImages = [];
  for (const image of result.images) {
    const fileName = basename(image.file);
    if (fileName !== image.file || !/^\d{2}-[a-z0-9-]+\.png$/u.test(fileName)) {
      throw new Error('generated image file name is invalid');
    }
    const content = await readFile(join(outputDirectory, fileName));
    const sha256 = createHash('sha256').update(content).digest('hex');
    const asset = uploads[fileName]?.sha256 === sha256
      ? uploads[fileName].asset
      : await controlPlane.uploadAsset(execution.id, { content, mediaType: 'image/png', fileName });
    uploads[fileName] = { sha256, asset };
    await saveCheckpoint(join(outputDirectory, 'uploads.json'), uploads);
    uploadedImages.push({ ...image, assetId: asset.id, url: asset.url });
  }
  await controlPlane.updateProgress(execution.id, {
    stage: 'FINALIZING', progressPercent: 99, message: '图片已上传，正在保存交付结果', details: {},
  });
  const completed = await controlPlane.completeImage(execution.id, {
    ...result,
    images: uploadedImages,
  });
  // Cleanup failure must not turn an accepted delivery into a failed task.
  await rm(taskRoot, { recursive: true, force: true }).catch(() => {});
  return completed;
}

export function createExecutorAgent({
  controlPlane,
  nodeId,
  nodeName = nodeId,
  imageWorkerEnabled = false,
  workRoot = resolve('data/executor-work'),
  executeCopy = executeCopyClaim,
  executeImage = executeImageClaim,
  readinessCheck = checkExecutorReady,
  environment = process.env,
}) {
  if (!controlPlane) throw new TypeError('controlPlane client is required');
  if (typeof imageWorkerEnabled !== 'boolean') throw new TypeError('imageWorkerEnabled must be a boolean');
  let ready = false;
  const pendingFailures = new Map();

  async function reportFailure(claim, error) {
    try {
      await controlPlane.failExecution(claim.execution.id, error);
    } catch (reportError) {
      if (reportError?.code !== 'STALE_EXECUTION') throw reportError;
    }
  }

  async function finishFailure(kind, { claim, error }) {
    await reportFailure(claim, error);
    pendingFailures.delete(kind);
    return {
      kind,
      taskId: claim.task.id,
      executionId: claim.execution.id,
      status: error?.code === 'STALE_EXECUTION' ? 'ABANDONED' : 'FAILED',
      error,
    };
  }

  async function claimAndExecute(kind) {
    if (!ready) throw new Error('executor is not ready; call prepare before claiming work');
    if (kind === 'IMAGE' && !imageWorkerEnabled) return null;
    // A failed report must be retried before claiming; the server still owns the
    // RUNNING lease. Never regenerate content just to retry a status update.
    if (pendingFailures.has(kind)) return finishFailure(kind, pendingFailures.get(kind));
    const claim = kind === 'COPY'
      ? await controlPlane.claimCopy(nodeId)
      : await controlPlane.claimImage(nodeId);
    if (!claim) return null;
    try {
      if (kind === 'COPY') {
        await executeCopy({ claim, controlPlane, environment });
      } else {
        await executeImage({ claim, controlPlane, workRoot, environment });
      }
      return { kind, taskId: claim.task.id, executionId: claim.execution.id, status: 'SUCCEEDED' };
    } catch (error) {
      const failure = { claim, error };
      pendingFailures.set(kind, failure);
      return finishFailure(kind, failure);
    }
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
      ready = true;
      return result;
    },

    async register() {
      if (!ready) throw new Error('executor is not ready; call prepare before register');
      return controlPlane.registerNode({ nodeId, name: nodeName, imageWorkerEnabled });
    },

    async heartbeat() {
      if (!ready) throw new Error('executor is not ready; call prepare before heartbeat');
      return controlPlane.registerNode({ nodeId, name: nodeName, imageWorkerEnabled });
    },

    runCopyOnce: () => claimAndExecute('COPY'),
    runImageOnce: () => claimAndExecute('IMAGE'),
  };
}
