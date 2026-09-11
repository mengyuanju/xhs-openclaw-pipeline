import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

import { deliveryCopyFromContent, resolveDeliveryArchiveSource } from './delivery-source.mjs';
import {
  assertDeliveryBindingsReady,
  loadReadyDeliveryTask,
} from './delivery-export.mjs';
import { ControlPlaneConflictError } from './domain.mjs';

export const MAX_DELIVERY_PREVIEW_TASKS = 200;
export const DEFAULT_DELIVERY_PREVIEW_TASKS = 50;
export const PREVIEW_SERVICE_BATCH_ITEMS = 10;
export const PREVIEW_SERVICE_BATCH_IMAGES = 60;
export const PREVIEW_SERVICE_BATCH_BYTES = 60 * 1024 * 1024;
export const PREVIEW_SERVICE_IMAGE_BYTES = 20 * 1024 * 1024;

const SUPPORTED_PREVIEW_MEDIA_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const NOTE_ID_PATTERN = /^[0-9a-f]{32}$/u;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_SUCCESS_BODY_BYTES = 1024 * 1024;

export class DeliveryPreviewServiceError extends Error {
  constructor(code, message, status = 502, details = undefined) {
    super(message);
    this.name = 'DeliveryPreviewServiceError';
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

export function normalizeDeliveryPreviewRequest(value) {
  if (!value || typeof value !== 'object' || value.scope !== 'QUERY_PACKAGES') {
    throw new TypeError('preview upload requires explicitly selected delivery sources');
  }
  if (!Array.isArray(value.queryPackageIds)
      || value.queryPackageIds.length > MAX_DELIVERY_PREVIEW_TASKS) {
    throw new RangeError(
      `queryPackageIds must contain between 0 and ${MAX_DELIVERY_PREVIEW_TASKS} items`,
    );
  }
  const queryPackageIds = [...value.queryPackageIds];
  if (queryPackageIds.some((id) => typeof id !== 'number'
      || !Number.isSafeInteger(id) || id < 1)
      || new Set(queryPackageIds).size !== queryPackageIds.length) {
    throw new TypeError('queryPackageIds must contain unique positive integers');
  }
  if (value.includeUnassigned !== undefined && typeof value.includeUnassigned !== 'boolean') {
    throw new TypeError('includeUnassigned must be a boolean');
  }
  const includeUnassigned = value.includeUnassigned === true;
  if (queryPackageIds.length + Number(includeUnassigned) < 1
      || queryPackageIds.length + Number(includeUnassigned) > MAX_DELIVERY_PREVIEW_TASKS) {
    throw new RangeError(
      `preview upload must explicitly select between 1 and ${MAX_DELIVERY_PREVIEW_TASKS} delivery sources`,
    );
  }
  const testTaskId = value.testTaskId === undefined || value.testTaskId === null
    ? null
    : value.testTaskId;
  if (testTaskId !== null
      && (typeof testTaskId !== 'number' || !Number.isSafeInteger(testTaskId) || testTaskId < 1)) {
    throw new TypeError('testTaskId must be a positive integer');
  }
  const limit = Number(value?.limit ?? DEFAULT_DELIVERY_PREVIEW_TASKS);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_DELIVERY_PREVIEW_TASKS) {
    throw new RangeError(
      `preview upload limit must be an integer from 1 to ${MAX_DELIVERY_PREVIEW_TASKS}`,
    );
  }
  if (testTaskId !== null && limit !== 1) {
    throw new RangeError('single-task preview testing requires limit 1');
  }
  return {
    scope: 'QUERY_PACKAGES', queryPackageIds, includeUnassigned, testTaskId, limit,
  };
}

export function createPreviewServiceClient({
  baseUrl,
  apiKey,
  fetchImpl = fetch,
  timeoutMs = 5 * 60_000,
} = {}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const normalizedApiKey = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!normalizedBaseUrl || !normalizedApiKey) return null;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30 * 60_000) {
    throw new RangeError('preview service timeout must be between 1000 and 1800000 milliseconds');
  }

  return Object.freeze({
    async publishBatch(items, { signal } = {}) {
      if (!Array.isArray(items) || items.length < 1 || items.length > PREVIEW_SERVICE_BATCH_ITEMS) {
        throw new RangeError(`preview batch must contain between 1 and ${PREVIEW_SERVICE_BATCH_ITEMS} items`);
      }
      const form = new FormData();
      form.set('manifest', JSON.stringify({
        items: items.map((item) => ({
          clientId: item.clientId,
          sourceRef: item.sourceRef,
          title: item.title,
          body: item.body,
          tags: item.tags.join(','),
        })),
      }));
      for (const item of items) {
        for (const asset of item.assets) {
          const content = await readFile(asset.path);
          if (content.byteLength !== asset.byteSize
              || createHash('sha256').update(content).digest('hex') !== asset.sha256) {
            throw new DeliveryPreviewServiceError(
              'DELIVERY_ASSET_CHANGED',
              `任务 ${item.taskId} 的交付图片已变化，请重新生成后再上传预览`,
              409,
            );
          }
          form.append(
            `images.${item.clientId}`,
            new File([content], asset.originalName, { type: asset.mediaType }),
          );
        }
      }
      const response = await callPreviewService(
        new URL('/api/v1/previews/batch', normalizedBaseUrl),
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${normalizedApiKey}` },
          body: form,
          signal: combinedSignal(signal, timeoutMs),
        },
        fetchImpl,
      );
      return parseBatchResponse(response, items, normalizedBaseUrl);
    },

    async revoke(previewId, { signal } = {}) {
      if (!UUID_PATTERN.test(String(previewId ?? ''))) {
        throw new TypeError('preview id is invalid');
      }
      const response = await callPreviewService(
        new URL(`/api/v1/previews/${encodeURIComponent(previewId)}/revoke`, normalizedBaseUrl),
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${normalizedApiKey}` },
          signal: combinedSignal(signal, timeoutMs),
        },
        fetchImpl,
      );
      const payload = await readBoundedJson(response, MAX_SUCCESS_BODY_BYTES);
      return {
        revokedAt: Number(payload?.revokedAt) || Date.now(),
      };
    },
  });
}

export function createDeliveryPreviewUrlResolver(baseUrl) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!normalizedBaseUrl) return null;
  return (rawNoteId) => publicPreviewUrl(normalizedBaseUrl, rawNoteId);
}

export function addDeliveryPreviewUrls(value, resolvePreviewUrl) {
  const decorate = (entry) => {
    if (!entry?.preview) return entry;
    return {
      ...entry,
      preview: {
        ...entry.preview,
        url: resolvePreviewUrl ? resolvePreviewUrl(entry.preview.noteId) : null,
      },
    };
  };
  if (Array.isArray(value)) return value.map(decorate);
  if (value && Array.isArray(value.items)) {
    return { ...value, items: value.items.map(decorate) };
  }
  return value;
}

export async function publishDeliveryPreviews({
  repository,
  storageRoot,
  previewClient,
  input,
  actor,
  signal,
}) {
  if (!previewClient) {
    throw new DeliveryPreviewServiceError(
      'PREVIEW_SERVICE_NOT_CONFIGURED',
      '预览服务尚未配置，请先设置服务地址和接口密钥',
      503,
    );
  }
  if (typeof repository?.recordDeliveryPreviewLinks !== 'function') {
    throw new ControlPlaneConflictError(
      'DELIVERY_PREVIEW_UNAVAILABLE',
      '中心服务尚未完成预览绑定升级',
    );
  }
  const request = normalizeDeliveryPreviewRequest(input);
  const taskIds = await resolvePreviewTaskIds(repository, request, actor);
  const preparedItems = [];
  for (const taskId of taskIds) {
    signal?.throwIfAborted();
    preparedItems.push(await prepareDeliveryPreviewItem({
      repository,
      storageRoot,
      taskId,
    }));
  }
  await assertDeliveryBindingsReady(
    repository,
    preparedItems.map((item) => item.binding),
  );

  const groups = groupPreviewItems(preparedItems);
  const published = [];
  const failures = [];
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const group = groups[groupIndex];
    signal?.throwIfAborted();
    try {
      await assertDeliveryBindingsReady(
        repository,
        group.map((item) => item.binding),
      );
      const remoteItems = await previewClient.publishBatch(group, { signal });
      const saved = await repository.recordDeliveryPreviewLinks(
        remoteItems.map((remote) => ({
          ...remote,
          deliveryEntryId: remote.source.binding.deliveryEntryId,
          taskId: remote.source.taskId,
          copyRevisionId: remote.source.binding.copyRevisionId,
          imageRunId: remote.source.binding.imageRunId,
        })),
        actor,
      );
      for (const [index, record] of saved.entries()) {
        const remote = remoteItems[index];
        if (!record.currentReady) {
          await revokeStalePreview(repository, previewClient, record.previewId, signal);
          failures.push({
            taskId: record.taskId,
            code: 'DELIVERY_VERSION_CHANGED',
            message: '交付版本在上传期间发生变化，生成的预览已撤销',
          });
          continue;
        }
        published.push({
          taskId: record.taskId,
          deliveryEntryId: record.deliveryEntryId,
          noteId: record.noteId,
          previewUrl: remote.previewUrl,
          reused: remote.reused,
        });
      }
    } catch (error) {
      const normalized = publicFailure(error);
      for (const item of groups.slice(groupIndex).flat()) {
        failures.push({ taskId: item.taskId, ...normalized });
      }
      break;
    }
  }

  return {
    scope: request.scope,
    limit: request.limit,
    requestedCount: taskIds.length,
    publishedCount: published.length,
    createdCount: published.filter((item) => !item.reused).length,
    reusedCount: published.filter((item) => item.reused).length,
    failedCount: failures.length,
    items: published,
    failures,
  };
}

async function resolvePreviewTaskIds(repository, request, actor) {
  if (typeof repository.listDeliveryPoolTaskIdsForPreview !== 'function') {
    throw new ControlPlaneConflictError(
      'DELIVERY_PREVIEW_UNAVAILABLE',
      '中心服务尚未完成预览绑定升级',
    );
  }
  const taskIds = await repository.listDeliveryPoolTaskIdsForPreview({
    actor,
    limit: request.limit,
    queryPackageIds: request.queryPackageIds,
    includeUnassigned: request.includeUnassigned,
    testTaskId: request.testTaskId,
  });
  if (!Array.isArray(taskIds) || taskIds.length === 0) {
    throw new ControlPlaneConflictError(
      'DELIVERY_PREVIEW_EMPTY',
      '当前范围没有尚未上传的 READY 交付项',
    );
  }
  return taskIds;
}

async function prepareDeliveryPreviewItem({ repository, storageRoot, taskId }) {
  const snapshot = await loadReadyDeliveryTask(repository, taskId);
  const { task, binding } = snapshot;
  if (!Number.isSafeInteger(binding.deliveryEntryId) || binding.deliveryEntryId < 1) {
    throw new ControlPlaneConflictError(
      'DELIVERY_PREVIEW_UNAVAILABLE',
      '中心服务无法确认交付条目，请完成数据库升级后重试',
    );
  }
  const revision = task.copyRevisions.find(
    (item) => Number(item.id) === binding.copyRevisionId,
  );
  const run = task.imageRuns.find((item) => String(item.id) === binding.imageRunId);
  const source = resolveDeliveryArchiveSource({
    content: revision?.content,
    imageResult: run?.result,
    availableAssetIds: task.assets.map((asset) => asset.id),
  });
  const copy = deliveryCopyFromContent(revision?.content);
  const title = String(copy?.title ?? '').trim();
  const body = String(copy?.body ?? '').trim();
  const tags = Array.isArray(copy?.tags)
    ? [...new Set(copy.tags.flatMap((tag) => String(tag).split(/[,，\n#]+/u))
      .map((tag) => tag.trim()).filter(Boolean))]
    : [];
  if (!title || title.length > 100 || body.length > 30_000
      || tags.length > 20 || tags.some((tag) => tag.length > 30)) {
    throw new ControlPlaneConflictError(
      'DELIVERY_PREVIEW_CONTENT_INVALID',
      `任务 ${task.id} 的交付文案不符合预览服务限制`,
    );
  }

  const assets = [];
  for (const assetId of source.assetIds) {
    const asset = await repository.getAsset(assetId);
    if (!asset || Number(asset.taskId) !== Number(task.id)
        || String(asset.imageRunId) !== binding.imageRunId) {
      throw new ControlPlaneConflictError(
        'DELIVERY_ASSET_MISSING',
        `任务 ${task.id} 的交付图片缺失`,
      );
    }
    if (!SUPPORTED_PREVIEW_MEDIA_TYPES.has(String(asset.mediaType))) {
      throw new ControlPlaneConflictError(
        'DELIVERY_PREVIEW_FORMAT_UNSUPPORTED',
        `任务 ${task.id} 包含预览系统不支持的图片格式`,
      );
    }
    const path = safeAssetPath(storageRoot, asset.storagePath);
    const metadata = await stat(path);
    const byteSize = Number(asset.byteSize);
    const sha256 = String(asset.sha256 ?? '').toLowerCase();
    if (!metadata.isFile() || !Number.isSafeInteger(byteSize) || byteSize < 1
        || byteSize > PREVIEW_SERVICE_IMAGE_BYTES || metadata.size !== byteSize
        || !HASH_PATTERN.test(sha256)) {
      throw new ControlPlaneConflictError(
        'DELIVERY_ASSET_INVALID',
        `任务 ${task.id} 的交付图片大小或校验信息无效`,
      );
    }
    assets.push({
      path,
      byteSize,
      sha256,
      mediaType: String(asset.mediaType),
      originalName: normalizedFileName(asset.originalName, assets.length + 1, asset.mediaType),
    });
  }
  return {
    taskId: Number(task.id),
    binding,
    clientId: `delivery_${binding.deliveryEntryId}`,
    sourceRef: `xhs:delivery:${binding.deliveryEntryId}`,
    title,
    body,
    tags,
    assets,
    imageCount: assets.length,
    byteSize: assets.reduce((total, asset) => total + asset.byteSize, 0),
  };
}

export function groupPreviewItems(items) {
  const groups = [];
  let group = [];
  let imageCount = 0;
  let byteSize = 0;
  for (const item of items) {
    if (!Array.isArray(item?.assets) || item.assets.length < 1
        || item.imageCount > PREVIEW_SERVICE_BATCH_IMAGES
        || item.byteSize > PREVIEW_SERVICE_BATCH_BYTES) {
      throw new ControlPlaneConflictError(
        'DELIVERY_PREVIEW_BATCH_TOO_LARGE',
        `任务 ${item?.taskId ?? ''} 的图片总大小超过预览服务单批限制`,
      );
    }
    const full = group.length >= PREVIEW_SERVICE_BATCH_ITEMS
      || imageCount + item.imageCount > PREVIEW_SERVICE_BATCH_IMAGES
      || byteSize + item.byteSize > PREVIEW_SERVICE_BATCH_BYTES;
    if (full) {
      groups.push(group);
      group = [];
      imageCount = 0;
      byteSize = 0;
    }
    group.push(item);
    imageCount += item.imageCount;
    byteSize += item.byteSize;
  }
  if (group.length > 0) groups.push(group);
  return groups;
}

async function revokeStalePreview(repository, previewClient, previewId, signal) {
  const revoked = await previewClient.revoke(previewId, { signal });
  if (typeof repository.markDeliveryPreviewRevoked === 'function') {
    await repository.markDeliveryPreviewRevoked(previewId, new Date(revoked.revokedAt));
  }
}

function normalizeBaseUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new TypeError('PREVIEW_BASE_URL must be a valid URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new TypeError('PREVIEW_BASE_URL must be a safe HTTP(S) URL');
  }
  url.hash = '';
  url.search = '';
  return url;
}

function safeAssetPath(storageRoot, storagePath) {
  const root = resolve(storageRoot);
  const path = resolve(String(storagePath ?? ''));
  const relation = relative(root, path);
  if (!relation || relation.startsWith('..') || relation.includes(':')) {
    throw new Error('delivery asset path escaped storage root');
  }
  return path;
}

function normalizedFileName(value, position, mediaType) {
  const extension = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/avif': 'avif',
  }[mediaType] ?? 'png';
  const name = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .trim();
  return [...(name || `image-${position}.${extension}`)].slice(0, 240).join('');
}

function combinedSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function callPreviewService(url, options, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, options);
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') throw error;
    throw new DeliveryPreviewServiceError(
      'PREVIEW_SERVICE_UNAVAILABLE',
      '无法连接预览服务，请稍后重试',
      503,
    );
  }
  if (response.ok) return response;
  const body = await readErrorBody(response);
  const remoteCode = body?.error?.code;
  const remoteMessage = body?.error?.message;
  if ([401, 403].includes(response.status)) {
    throw new DeliveryPreviewServiceError(
      'PREVIEW_SERVICE_AUTH_FAILED',
      '预览服务接口密钥无效或缺少创建权限',
      503,
    );
  }
  if (response.status === 429) {
    throw new DeliveryPreviewServiceError(
      'PREVIEW_SERVICE_RATE_LIMITED',
      '预览服务调用过于频繁，请稍后重试',
      429,
    );
  }
  throw new DeliveryPreviewServiceError(
    'PREVIEW_SERVICE_REJECTED',
    typeof remoteMessage === 'string' && remoteMessage
      ? remoteMessage
      : `预览服务拒绝了上传（${response.status}）`,
    response.status >= 500 ? 503 : 409,
    typeof remoteCode === 'string' ? { remoteCode } : undefined,
  );
}

async function readErrorBody(response) {
  return readBoundedJson(response, MAX_ERROR_BODY_BYTES);
}

async function readBoundedJson(response, maximumBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let byteSize = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteSize += value.byteLength;
      if (byteSize > maximumBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks, byteSize).toString('utf8'));
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

async function parseBatchResponse(response, sourceItems, baseUrl) {
  const payload = await readBoundedJson(response, MAX_SUCCESS_BODY_BYTES);
  if (!payload || !Array.isArray(payload.items) || payload.items.length !== sourceItems.length) {
    throw new DeliveryPreviewServiceError(
      'PREVIEW_SERVICE_INVALID_RESPONSE',
      '预览服务返回了无效的批量结果',
    );
  }
  const sourceByClientId = new Map(sourceItems.map((item) => [item.clientId, item]));
  const seen = new Set();
  const seenPreviewIds = new Set();
  const seenNoteIds = new Set();
  return payload.items.map((item) => {
    const clientId = String(item?.clientId ?? '');
    const source = sourceByClientId.get(clientId);
    const preview = item?.preview;
    const previewId = String(preview?.id ?? '').toLowerCase();
    const noteId = String(preview?.publicId ?? '').toLowerCase();
    const contentHash = String(preview?.contentHash ?? '').toLowerCase();
    const publishedAt = Number(preview?.publishedAt);
    const expectedContentHash = createHash('sha256').update(JSON.stringify({
      title: source?.title,
      body: source?.body,
      tags: source?.tags,
      images: source?.assets.map((asset) => asset.sha256),
    })).digest('hex');
    let previewUrl;
    try {
      previewUrl = new URL(String(item?.previewUrl ?? ''));
    } catch {
      previewUrl = null;
    }
    if (!source || seen.has(clientId) || seenPreviewIds.has(previewId)
        || seenNoteIds.has(noteId) || !UUID_PATTERN.test(previewId)
        || !NOTE_ID_PATTERN.test(noteId) || !HASH_PATTERN.test(contentHash)
        || contentHash !== expectedContentHash || preview?.status !== 'PUBLISHED'
        || !Number.isSafeInteger(publishedAt) || publishedAt < 1
        || !previewUrl || previewUrl.origin !== baseUrl.origin
        || previewUrl.username || previewUrl.password
        || previewUrl.searchParams.get('noteId') !== noteId) {
      throw new DeliveryPreviewServiceError(
        'PREVIEW_SERVICE_INVALID_RESPONSE',
        '预览服务返回了无效的批量结果',
      );
    }
    seen.add(clientId);
    seenPreviewIds.add(previewId);
    seenNoteIds.add(noteId);
    return {
      source,
      sourceRef: source.sourceRef,
      previewId,
      noteId,
      previewUrl: publicPreviewUrl(baseUrl, noteId),
      contentHash,
      publishedAt,
      reused: item.reused === true,
    };
  });
}

function publicPreviewUrl(baseUrl, rawNoteId) {
  const noteId = String(rawNoteId ?? '').trim().toLowerCase();
  if (!NOTE_ID_PATTERN.test(noteId)) throw new TypeError('preview noteId is invalid');
  const url = new URL('/preview', baseUrl);
  url.searchParams.set('noteId', noteId);
  return url.href;
}

function publicFailure(error) {
  if (error instanceof DeliveryPreviewServiceError
      || error instanceof ControlPlaneConflictError) {
    return { code: error.code, message: error.message };
  }
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
    return { code: 'PREVIEW_UPLOAD_TIMEOUT', message: '预览上传超时或已取消' };
  }
  return { code: 'PREVIEW_UPLOAD_FAILED', message: '预览上传失败，请稍后重试' };
}
