import { IMAGE_FORMATS } from './image-options.mjs';
import { HttpError, readBody, ASSET_BODY_LIMIT, safeStoragePath } from './http-route-common.mjs';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
export async function uploadAsset({
  ctx,
  repository,
  storageRoot,
  executionId
}) {
  const mediaType = String(ctx.request.headers['content-type'] ?? '').split(';')[0].trim();
  const imageFormat = Object.values(IMAGE_FORMATS).find(format => format.mediaType === mediaType);
  const extension = imageFormat ? `.${imageFormat.extension}` : mediaType === 'application/json' ? '.json' : null;
  if (!extension) throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'asset type is not supported');
  const body = await readBody(ctx.req, ASSET_BODY_LIMIT);
  const context = await repository.activeImageUploadContext(executionId);
  const directory = safeStoragePath(storageRoot, 'tasks', String(context.taskId), 'image-runs', context.imageRunId);
  await mkdir(directory, {
    recursive: true
  });
  const storagePath = safeStoragePath(directory, `${randomUUID()}${extension}`);
  await writeFile(storagePath, body, {
    flag: 'wx'
  });
  try {
    const asset = await repository.recordAsset({
      executionId,
      mediaType,
      byteSize: body.length,
      sha256: createHash('sha256').update(body).digest('hex'),
      storagePath,
      originalName: ctx.request.headers['x-file-name'] ?? null
    });
    if (asset.reused) await rm(storagePath, {
      force: true
    });
    return asset;
  } catch (error) {
    await rm(storagePath, {
      force: true
    }).catch(() => {});
    throw error;
  }
}
export async function uploadKnowledgeAsset({
  ctx,
  repository,
  storageRoot,
  versionId
}) {
  const mediaType = String(ctx.request.headers['content-type'] ?? '').split(';')[0].trim();
  if (mediaType !== 'image/png') {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'knowledge assets must be normalized PNG images');
  }
  const body = await readBody(ctx.req, ASSET_BODY_LIMIT);
  const context = await repository.knowledgeUploadContext(versionId);
  const directory = safeStoragePath(storageRoot, 'knowledge', context.kind.toLowerCase(), String(context.itemId), String(context.versionId));
  await mkdir(directory, {
    recursive: true
  });
  const storagePath = safeStoragePath(directory, `${randomUUID()}.png`);
  await writeFile(storagePath, body, {
    flag: 'wx'
  });
  try {
    return await repository.attachKnowledgeAsset({
      versionId,
      storagePath,
      sha256: createHash('sha256').update(body).digest('hex')
    });
  } catch (error) {
    await rm(storagePath, {
      force: true
    }).catch(() => {});
    throw error;
  }
}
