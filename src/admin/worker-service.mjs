import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';
import sharp from 'sharp';

function safeAbsolute(root, child) {
  const rootPath = resolve(root);
  const path = resolve(rootPath, child);
  const relation = relative(rootPath, path);
  if (!relation || relation.startsWith('..')) throw new Error('worker asset path escaped the asset root');
  return path;
}

async function copyGeneratedAsset({ store, assetRoot, task, image, outputDir, mode }) {
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
  await writeFile(destination, content, { flag: 'wx' });
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
    });
  } catch (error) {
    await unlink(destination).catch(() => {});
    throw error;
  }
}

export function createAdminWorkerIntegration({ store, assetRoot }) {
  if (!store?.getWorkerConfig) throw new TypeError('admin store with worker config is required');
  const normalizedAssetRoot = resolve(assetRoot);

  return {
    getTaskConfig(task) {
      const config = store.getWorkerConfig(task.id);
      if (!config) return null;
      return {
        ...config,
        referenceImagePaths: config.referenceAssets.map((asset) =>
          safeAbsolute(normalizedAssetRoot, asset.relativePath)),
      };
    },

    async onCompleted({ task, post, images, outputDir, qc, mode }) {
      if (!store.getWorkerConfig(task.id)) return;
      for (const image of images) {
        await copyGeneratedAsset({ store, assetRoot: normalizedAssetRoot, task, image, outputDir, mode });
      }
      store.addTextRevision(task.id, {
        title: post.title,
        body: post.body,
        tags: post.tags,
        source: 'GENERATED',
      });
      store.addGenerationRun({
        taskId: task.id,
        attempt: task.attempts,
        mode,
        status: 'COMPLETED',
        outputDir,
        qc,
      });
    },

    async onFailed({ task, outputDir, mode, error }) {
      if (!store.getWorkerConfig(task.id)) return;
      store.addGenerationRun({
        taskId: task.id,
        attempt: task.attempts,
        mode,
        status: 'FAILED',
        outputDir,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  };
}
