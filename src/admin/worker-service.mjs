import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import sharp from 'sharp';

import { materializeFile, optimizeTaskStorage } from './storage-optimizer.mjs';

function safeAbsolute(root, child) {
  const rootPath = resolve(root);
  const path = resolve(rootPath, child);
  const relation = relative(rootPath, path);
  if (!relation || relation.startsWith('..')) throw new Error('worker asset path escaped the asset root');
  return path;
}

async function copyGeneratedAsset({
  store,
  assetRoot,
  task,
  image,
  outputDir,
  mode,
  sourceTextRevisionId,
  pageIndex,
  visualPlanSha256,
}) {
  const sourcePath = resolve(outputDir, image.file);
  const sourceRelation = relative(resolve(outputDir), sourcePath);
  if (!sourceRelation || sourceRelation.startsWith('..') || basename(image.file) !== image.file) {
    throw new Error('generated image path is invalid');
  }
  const content = await readFile(sourcePath);
  const metadata = await sharp(content, { failOn: 'error', limitInputPixels: 40_000_000 }).metadata();
  if (metadata.format !== 'png' || !metadata.width || !metadata.height) {
    throw new Error('generated image is not a valid PNG');
  }
  const fileName = `${randomUUID()}-${image.file}`;
  const relativePath = `generated/${task.id}/attempt-${task.attempts}/${fileName}`;
  const destination = safeAbsolute(assetRoot, relativePath);
  await mkdir(dirname(destination), { recursive: true });
  await materializeFile(sourcePath, destination);
  try {
    return store.addAsset({
      taskId: task.id,
      kind: 'GENERATED',
      fileName,
      relativePath,
      mimeType: 'image/png',
      width: metadata.width,
      height: metadata.height,
      sha256: createHash('sha256').update(content).digest('hex'),
      source: `${mode}:${image.provider}`,
      sourceTextRevisionId,
      pageIndex,
      visualPlanSha256,
      alignmentStatus: image.alignment?.passed === true ? 'PASSED' : 'UNVERIFIED',
      alignmentResult: image.alignment ?? {},
    });
  } catch (error) {
    await unlink(destination).catch(() => {});
    throw error;
  }
}

async function syncFailedPreview({ store, assetRoot, task, outputDir, mode }) {
  const [post, visualPlan, manifest, qc] = await Promise.all([
    readFile(join(outputDir, 'post.json'), 'utf8').then(JSON.parse),
    readFile(join(outputDir, 'visual-plan.json'), 'utf8').then(JSON.parse),
    readFile(join(outputDir, 'manifest.json'), 'utf8').then(JSON.parse),
    readFile(join(outputDir, 'qc.json'), 'utf8').then(JSON.parse),
  ]);
  if (!post || typeof post !== 'object' || !Array.isArray(post.tags)
    || !visualPlan || typeof visualPlan !== 'object'
    || !Array.isArray(manifest?.images) || manifest.images.length < 3 || manifest.images.length > 5) {
    throw new TypeError('failed delivery preview artifacts are incomplete');
  }
  const currentRevision = store.getTask(task.id)?.currentTextRevision;
  const revision = currentRevision?.source === 'MANUAL'
    ? currentRevision
    : store.addTextRevision(task.id, {
        title: post.title,
        body: post.body,
        tags: post.tags,
        source: 'GENERATED',
      });
  const visualPlanSha256 = createHash('sha256')
    .update(`${JSON.stringify(visualPlan, null, 2)}\n`)
    .digest('hex');
  for (const [index, image] of manifest.images.entries()) {
    await copyGeneratedAsset({
      store,
      assetRoot,
      task,
      image,
      outputDir,
      mode,
      sourceTextRevisionId: revision.id,
      pageIndex: index + 1,
      visualPlanSha256,
    });
  }
  store.setTaskImageCount(task.id, manifest.images.length);
  return { qc, visualPlan };
}

async function loadLatestGeneratedPost(generationRuns) {
  for (const run of generationRuns.slice().reverse()) {
    if (!run.outputDir) continue;
    try {
      return JSON.parse(await readFile(join(run.outputDir, 'post.json'), 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  throw new Error('manual text revision requires a previous generated post');
}

export function createAdminWorkerIntegration({
  store,
  assetRoot,
  knowledgeRoot,
  optimizeStorage = optimizeTaskStorage,
  logger = console,
}) {
  if (!store?.getWorkerConfig) throw new TypeError('admin store with worker config is required');
  const normalizedAssetRoot = resolve(assetRoot);
  const normalizedKnowledgeRoot = knowledgeRoot ? resolve(knowledgeRoot) : null;
  const optimizeAfterAttempt = async (taskId, outputDir) => {
    try {
      return await optimizeStorage({
        store,
        taskId,
        assetRoot: normalizedAssetRoot,
        outputRoot: dirname(dirname(resolve(outputDir))),
        apply: true,
      });
    } catch (error) {
      logger?.warn?.(`Storage cleanup skipped for task ${taskId}: ${error.message ?? String(error)}`);
      return null;
    }
  };

  return {
    async getTaskConfig(task) {
      const config = store.getWorkerConfig(task.id);
      if (!config) return null;
      const detail = store.getTask(task.id);
      let postOverride = null;
      if (detail?.currentTextRevision?.source === 'MANUAL') {
        const previousPost = await loadLatestGeneratedPost(detail.generationRuns);
        postOverride = {
          ...previousPost,
          title: detail.currentTextRevision.title,
          body: detail.currentTextRevision.body,
          tags: detail.currentTextRevision.tags,
        };
      }
      return {
        ...config,
        imageCountMode: 'auto',
        referenceImagePaths: config.referenceAssets.map((asset) =>
          safeAbsolute(normalizedAssetRoot, asset.relativePath)),
        resolveVisualReference(contentProfile) {
          const visualReference = store.resolveVisualReferenceForTask?.(task.id, { contentProfile }) ?? null;
          const visualReferenceImagePaths = visualReference?.referenceImageRelativePath
            ? [safeAbsolute(
                normalizedKnowledgeRoot ?? normalizedAssetRoot,
                visualReference.referenceImageRelativePath,
              )]
            : [];
          return { visualReference, visualReferenceImagePaths };
        },
        currentTextRevisionId: detail?.currentTextRevision?.source === 'MANUAL'
          ? detail.currentTextRevision.id
          : null,
        postOverride,
      };
    },

    async onCompleted({
      task,
      post,
      visualPlan,
      images,
      outputDir,
      qc,
      mode,
      imageCount,
      sourceTextRevisionId,
      promptTrace,
      researchSnapshot,
      stageReviews,
      startedAt,
      finishedAt,
    }) {
      if (!store.getWorkerConfig(task.id)) return;
      const currentRevision = store.getTask(task.id)?.currentTextRevision;
      const revision = sourceTextRevisionId
        ? currentRevision
        : store.addTextRevision(task.id, {
            title: post.title,
            body: post.body,
            tags: post.tags,
            source: 'GENERATED',
          });
      if (!revision || (sourceTextRevisionId && revision.id !== sourceTextRevisionId)) {
        throw new Error('current manual text revision changed during image generation');
      }
      const visualPlanSha256 = createHash('sha256')
        .update(`${JSON.stringify(visualPlan, null, 2)}\n`)
        .digest('hex');
      for (const [index, image] of images.entries()) {
        await copyGeneratedAsset({
          store,
          assetRoot: normalizedAssetRoot,
          task,
          image,
          outputDir,
          mode,
          sourceTextRevisionId: revision.id,
          pageIndex: index + 1,
          visualPlanSha256,
        });
      }
      store.setTaskImageCount(task.id, imageCount);
      store.addGenerationRun({
        taskId: task.id,
        attempt: task.attempts,
        mode,
        status: 'COMPLETED',
        outputDir,
        qc,
        promptTrace,
        visualPlan,
        researchSnapshot,
        stageReviews,
        startedAt,
        finishedAt,
      });
      await optimizeAfterAttempt(task.id, outputDir);
    },

    async onFailed({
      task,
      outputDir,
      mode,
      error,
      qc: pipelineQc,
      promptTrace,
      researchSnapshot,
      stageReviews,
      visualPlan,
      startedAt,
      finishedAt,
    }) {
      if (!store.getWorkerConfig(task.id)) return;
      let qc = pipelineQc ?? null;
      let runVisualPlan = visualPlan ?? null;
      let previewError = null;
      try {
        const preview = await syncFailedPreview({
          store,
          assetRoot: normalizedAssetRoot,
          task,
          outputDir,
          mode,
        });
        qc = preview.qc;
        runVisualPlan ??= preview.visualPlan;
      } catch (artifactError) {
        if (artifactError?.code !== 'ENOENT') previewError = artifactError;
      }
      const originalError = error instanceof Error ? error.message : String(error);
      store.addGenerationRun({
        taskId: task.id,
        attempt: task.attempts,
        mode,
        status: 'FAILED',
        outputDir,
        qc,
        promptTrace,
        visualPlan: runVisualPlan,
        researchSnapshot,
        stageReviews,
        error: previewError
          ? `${originalError}；失败预览同步异常：${previewError.message ?? String(previewError)}`
          : originalError,
        startedAt,
        finishedAt,
      });
      await optimizeAfterAttempt(task.id, outputDir);
    },
  };
}
