import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

import JSZip from 'jszip';

const IMAGE_EXTENSIONS = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
]);
const MAX_EXPORT_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_BATCH_EXPORT_TASKS = 30;
export const MAX_BATCH_EXPORT_BYTES = 250 * 1024 * 1024;

export class TaskExportError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'TaskExportError';
    this.code = code;
  }
}

function deliveryAvailability(task) {
  const reviewStatus = task?.config?.reviewStatus;
  if (reviewStatus === 'REJECTED') {
    return { canExport: false, reason: '任务已驳回，请重新打开审核后再导出', assets: [] };
  }
  if (!['WAITING_REVIEW', 'APPROVED'].includes(reviewStatus)) {
    return { canExport: false, reason: '任务生成完成并进入待审核后才能导出', assets: [] };
  }
  const currentRevisionId = task.currentTextRevision?.id ?? task.config.currentTextRevisionId;
  if (!Number.isSafeInteger(currentRevisionId) || currentRevisionId < 1) {
    return { canExport: false, reason: '当前文案不存在，无法导出', assets: [] };
  }
  const imageCount = task.config.imageCount;
  if (!Number.isInteger(imageCount) || imageCount < 3 || imageCount > 5) {
    return { canExport: false, reason: '交付图片数量无效，无法导出', assets: [] };
  }

  if (!Array.isArray(task.assets) && task.exportReadiness) {
    if (task.exportReadiness.assetCount !== imageCount) {
      return { canExport: false, reason: '当前文案缺少完整交付图片，无法导出', assets: [] };
    }
    if (reviewStatus === 'APPROVED' && task.exportReadiness.alignedAssetCount !== imageCount) {
      return { canExport: false, reason: '已通过任务的当前图片未全部通过验收，无法导出', assets: [] };
    }
    return { canExport: true, reason: null, assets: [] };
  }

  const latestByPage = new Map();
  for (const asset of task.assets ?? []) {
    if (!['GENERATED', 'EDITED'].includes(asset.kind)
      || asset.sourceTextRevisionId !== currentRevisionId
      || !Number.isInteger(asset.pageIndex)) continue;
    const previous = latestByPage.get(asset.pageIndex);
    if (!previous || asset.id > previous.id) latestByPage.set(asset.pageIndex, asset);
  }
  const assets = Array.from({ length: imageCount }, (_, index) => latestByPage.get(index + 1));
  if (assets.some((asset) => !asset)) {
    return { canExport: false, reason: '当前文案缺少完整交付图片，无法导出', assets: [] };
  }
  if (reviewStatus === 'APPROVED' && assets.some((asset) => asset.alignmentStatus !== 'PASSED')) {
    return { canExport: false, reason: '已通过任务的当前图片未全部通过验收，无法导出', assets: [] };
  }
  return { canExport: true, reason: null, assets };
}

export function getTaskExportAvailability(task) {
  const { canExport, reason } = deliveryAvailability(task);
  return { canExport, reason };
}

function currentDeliveryAssets(task) {
  const availability = deliveryAvailability(task);
  if (!availability.canExport) {
    throw new TaskExportError('NOT_READY', availability.reason);
  }
  return availability.assets;
}

function resolveAssetPath(assetRoot, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new TaskExportError('INVALID_ASSET_PATH', '交付图片路径无效');
  }
  const root = resolve(assetRoot);
  const path = resolve(root, relativePath);
  const relation = relative(root, path);
  if (!relation || relation.startsWith('..')) {
    throw new TaskExportError('INVALID_ASSET_PATH', '交付图片路径超出受控目录');
  }
  return path;
}

function exportCopyText(revision) {
  return [
    '标题',
    revision.title,
    '',
    '正文',
    revision.body,
    '',
    '标签',
    revision.tags.join(' '),
    '',
  ].join('\n');
}

function exportTimestamp(exportedAt) {
  return exportedAt instanceof Date ? exportedAt.toISOString() : new Date(exportedAt).toISOString();
}

async function addTaskExportFiles(zip, {
  task,
  assetRoot,
  exportedAt,
  prefix = '',
  maxBytes = Number.POSITIVE_INFINITY,
}) {
  const assets = currentDeliveryAssets(task);
  const current = task.currentTextRevision;
  const imageMetadata = [];
  let byteLength = 0;

  const reserve = (size) => {
    if (byteLength + size > maxBytes) {
      throw new TaskExportError('BATCH_TOO_LARGE', '批量导出文件过大，请减少所选任务');
    }
    byteLength += size;
  };

  for (const asset of assets) {
    const extension = IMAGE_EXTENSIONS.get(asset.mimeType);
    if (!extension) throw new TaskExportError('INVALID_ASSET', '交付图片格式不支持导出');
    const fileName = `images/${String(asset.pageIndex).padStart(2, '0')}.${extension}`;
    let content;
    try {
      content = await readFile(resolveAssetPath(assetRoot, asset.relativePath));
    } catch (error) {
      if (error instanceof TaskExportError) throw error;
      if (error?.code === 'ENOENT') {
        throw new TaskExportError('ASSET_MISSING', '交付图片文件不存在', { cause: error });
      }
      throw error;
    }
    if (content.byteLength > MAX_EXPORT_IMAGE_BYTES) {
      throw new TaskExportError('ASSET_TOO_LARGE', '单张交付图片超过 20 MiB，无法导出');
    }
    reserve(content.byteLength);
    zip.file(`${prefix}${fileName}`, content);
    imageMetadata.push({
      pageIndex: asset.pageIndex,
      fileName,
      assetId: asset.id,
      sha256: asset.sha256,
    });
  }

  const timestamp = exportTimestamp(exportedAt);
  const metadata = {
    taskId: task.id,
    externalId: task.config.externalId,
    query: task.query,
    title: current.title,
    body: current.body,
    tags: current.tags,
    textRevisionId: current.id,
    reviewStatus: task.config.reviewStatus,
    imageCount: assets.length,
    exportedAt: timestamp,
    images: imageMetadata,
  };
  const copyText = exportCopyText(current);
  const metadataText = `${JSON.stringify(metadata, null, 2)}\n`;
  reserve(Buffer.byteLength(copyText));
  reserve(Buffer.byteLength(metadataText));
  zip.file(`${prefix}content.txt`, copyText);
  zip.file(`${prefix}metadata.json`, metadataText);

  return { byteLength, metadata };
}

export async function buildTaskExportArchive({ task, assetRoot, exportedAt = new Date() }) {
  const zip = new JSZip();
  await addTaskExportFiles(zip, { task, assetRoot, exportedAt });

  return {
    fileName: `xhs-task-${task.id}.zip`,
    buffer: await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    }),
  };
}

export async function buildTaskBatchExportArchive({
  tasks,
  assetRoot,
  exportedAt = new Date(),
  maxBytes = MAX_BATCH_EXPORT_BYTES,
}) {
  if (!Array.isArray(tasks) || tasks.length < 1) {
    throw new TaskExportError('INVALID_BATCH', '请至少选择 1 个任务');
  }
  if (tasks.length > MAX_BATCH_EXPORT_TASKS) {
    throw new TaskExportError('INVALID_BATCH', `一次最多导出 ${MAX_BATCH_EXPORT_TASKS} 个任务`);
  }
  const taskIds = tasks.map((task) => task?.id);
  if (taskIds.some((id) => !Number.isSafeInteger(id) || id < 1)) {
    throw new TaskExportError('INVALID_BATCH', '任务 ID 无效');
  }
  if (new Set(taskIds).size !== taskIds.length) {
    throw new TaskExportError('INVALID_BATCH', '批量导出的任务不能重复');
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BATCH_EXPORT_BYTES) {
    throw new TaskExportError('INVALID_BATCH', '批量导出大小限制无效');
  }

  const timestamp = exportTimestamp(exportedAt);
  const zip = new JSZip();
  const manifestTasks = [];
  let remainingBytes = maxBytes;

  for (const task of tasks) {
    const folder = `tasks/task-${task.id}/`;
    try {
      const result = await addTaskExportFiles(zip, {
        task,
        assetRoot,
        exportedAt: timestamp,
        prefix: folder,
        maxBytes: remainingBytes,
      });
      remainingBytes -= result.byteLength;
    } catch (error) {
      if (error instanceof TaskExportError) {
        throw new TaskExportError(error.code, `任务 #${task.id}：${error.message}`, { cause: error });
      }
      throw error;
    }
    manifestTasks.push({
      taskId: task.id,
      externalId: task.config.externalId,
      query: task.query,
      folder,
    });
  }

  const manifestText = `${JSON.stringify({
    exportedAt: timestamp,
    taskCount: manifestTasks.length,
    tasks: manifestTasks,
  }, null, 2)}\n`;
  if (Buffer.byteLength(manifestText) > remainingBytes) {
    throw new TaskExportError('BATCH_TOO_LARGE', '批量导出文件过大，请减少所选任务');
  }
  zip.file('manifest.json', manifestText);

  return {
    fileName: `xhs-task-batch-${timestamp.replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '')}.zip`,
    buffer: await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    }),
  };
}
