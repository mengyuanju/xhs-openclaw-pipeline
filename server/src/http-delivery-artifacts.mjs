import { Readable } from 'node:stream';
import { createReadStream, createWriteStream } from 'node:fs';
import { DELIVERY_EXPORT_TTL_MS, loadReadyDeliveryTask } from './delivery-export.mjs';
import { safeStoragePath, DELIVERY_IMAGE_MEDIA_TYPES, ASSET_BODY_LIMIT } from './http-route-common.mjs';
import { readdir, stat, rm, mkdir, readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { writeBatchTaskArchive } from './task-archive.mjs';
import { relative } from 'node:path';
import { ControlPlaneNotFoundError, ControlPlaneConflictError } from './domain.mjs';
import { deliverySpreadsheetAssetIds, MAX_DELIVERY_SPREADSHEET_TASKS, writeDeliverySpreadsheetExport } from './delivery-spreadsheet.mjs';
import { createDeliverySnapshot, saveDeliverySnapshot, loadDeliverySnapshot,
  removeDeliverySnapshot, stageSnapshotBatchArchive, buildSnapshotSpreadsheetTasks,
  openSnapshotFile } from './delivery-snapshots.mjs';
export function lazyFileStream(path) {
  return Readable.from(async function* readWhenRequested() {
    const source = createReadStream(path);
    try {
      for await (const chunk of source) yield chunk;
    } finally {
      source.destroy();
    }
  }());
}
export const DELIVERY_EXPORT_DIRECTORY = '.delivery-exports';
export const DELIVERY_BATCH_DIRECTORY = '.delivery-batches';
export const DELIVERY_EXPORT_STALE_MS = Math.max(60 * 60_000, DELIVERY_EXPORT_TTL_MS * 2);
export const DELIVERY_EXPORT_SWEEP_MS = 15 * 60_000;
export const DELIVERY_EXPORT_DIRECTORY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export async function cleanStaleDeliveryExportDirectories(storageRoot, now = Date.now()) {
  const root = safeStoragePath(storageRoot, DELIVERY_EXPORT_DIRECTORY);
  let entries;
  try {
    entries = await readdir(root, {
      withFileTypes: true
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  await Promise.all(entries.filter(entry => entry.isDirectory() && DELIVERY_EXPORT_DIRECTORY_PATTERN.test(entry.name)).map(async entry => {
    const directory = safeStoragePath(root, entry.name);
    const artifacts = await Promise.all([safeStoragePath(directory, 'delivery-pool.zip'), safeStoragePath(directory, 'delivery-pool.xlsx')].map(path => stat(path).catch(error => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    })));
    const metadata = artifacts.filter(Boolean).sort((left, right) => right.mtimeMs - left.mtimeMs)[0] ?? (await stat(directory));
    if (now - metadata.mtimeMs < DELIVERY_EXPORT_STALE_MS) return;
    await rm(directory, {
      recursive: true,
      force: true
    });
  }));
}
export async function stageDeliveryPoolArchive(repository, storageRoot, taskIds, {
  signal
} = {}) {
  const exportDirectory = safeStoragePath(storageRoot, DELIVERY_EXPORT_DIRECTORY, randomUUID());
  const archivePath = safeStoragePath(exportDirectory, 'delivery-pool.zip');
  await mkdir(exportDirectory, {
    recursive: true
  });
  const bindings = [];
  const imageSources = [];
  const taskSnapshots = [];
  try {
    async function* readyTasks() {
      for (const taskId of taskIds) {
        signal?.throwIfAborted();
        const snapshot = await loadReadyDeliveryTask(repository, taskId);
        bindings.push(snapshot.binding);
        const task = snapshot.task;
        taskSnapshots.push({
          id: task.id, query: task.query, issuedQuery: task.issuedQuery,
          sourceQueryPackageName: task.sourceQueryPackageName, sourceClientBatchCode: task.sourceClientBatchCode,
          currentCopyRevisionId: task.currentCopyRevisionId, currentImageRunId: task.currentImageRunId,
          copyRevisions: task.copyRevisions?.filter(revision => revision.id === task.currentCopyRevisionId),
          imageRuns: task.imageRuns?.filter(run => run.id === task.currentImageRunId),
          assets: task.assets?.filter(asset => asset.imageRunId === task.currentImageRunId),
          xiaohongshuLinks: task.xiaohongshuLinks,
          xiaohongshuSearchStatus: task.xiaohongshuSearchStatus,
          xiaohongshuSearchBlockedReason: task.xiaohongshuSearchBlockedReason,
        });
        yield snapshot.task;
      }
    }
    const output = createWriteStream(archivePath, {
      flags: 'wx',
      signal
    });
    const result = await writeBatchTaskArchive(readyTasks(), async (task, assetId) => {
      signal?.throwIfAborted();
      const asset = await repository.getAsset(assetId);
      signal?.throwIfAborted();
      if (!asset || asset.taskId !== task.id) return null;
      const path = safeStoragePath(storageRoot, relative(storageRoot, asset.storagePath));
      const metadata = await stat(path);
      signal?.throwIfAborted();
      if (!metadata.isFile()) return null;
      imageSources.push({
        assetId: asset.id,
        taskId: task.id,
        storagePath: relative(storageRoot, path).replaceAll('\\', '/'),
        byteSize: metadata.size,
        sha256: asset.sha256 || await fileSha256(path),
      });
      return {
        ...asset,
        content: lazyFileStream(path)
      };
    }, output, {
      maxTasks: Number.POSITIVE_INFINITY,
      signal
    });
    return {
      archivePath,
      byteSize: (await stat(archivePath)).size,
      taskCount: result.taskCount,
      bindings,
      imageSources,
      taskSnapshots,
      cleanup: () => rm(exportDirectory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100
      })
    };
  } catch (error) {
    await rm(exportDirectory, {
      recursive: true,
      force: true
    }).catch(() => {});
    throw error;
  }
}
export async function fileSha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export function deliveryBatchArchivePath(storageRoot, publicId) {
  const id = String(publicId ?? '').toLowerCase();
  if (!DELIVERY_EXPORT_DIRECTORY_PATTERN.test(id)) {
    throw new ControlPlaneNotFoundError('delivery batch not found');
  }
  return safeStoragePath(storageRoot, DELIVERY_BATCH_DIRECTORY, `${id}.zip`);
}
export async function persistDeliveryBatchSnapshot(storageRoot, staged, publicId, { signal } = {}) {
  try {
    const snapshot = await createDeliverySnapshot(storageRoot, staged.archivePath, publicId, {
      expectedByteSize: staged.byteSize,
      taskSnapshots: staged.taskSnapshots,
      signal,
      resolveImage: async ({ sha256, byteSize, taskId }) => staged.imageSources?.find(source =>
        source.sha256 === sha256 && source.byteSize === byteSize
        && Number(source.taskId) === Number(taskId)),
    });
    signal?.throwIfAborted();
    await saveDeliverySnapshot(storageRoot, snapshot);
    return {
      ...staged,
      sha256: snapshot.sourceArchive.sha256,
      snapshotAssets: staged.imageSources.map(source => ({ ...source,
        storagePath: safeStoragePath(storageRoot, source.storagePath),
      })),
      // The ZIP remains a temporary download; only its reconstruction snapshot persists.
      removePersistent: async () => {
        try { await removeDeliverySnapshot(storageRoot, publicId); }
        finally { await staged.cleanup(); }
      },
    };
  } catch (error) {
    await staged.cleanup().catch(() => {});
    throw error;
  }
}
export async function storedDeliveryBatchArtifact(repository, storageRoot, publicId, actor) {
  const batch = await repository.getDeliveryBatchArtifact(publicId, {
    actor
  });
  const snapshot = await loadDeliverySnapshot(storageRoot, batch.publicId);
  if (snapshot.sourceArchive.sha256 !== batch.sha256
      || snapshot.sourceArchive.byteSize !== batch.byteSize) {
    throw new ControlPlaneConflictError('DELIVERY_BATCH_SOURCE_MISSING', '该交付批次的快照与交付记录不一致，请检查快照数据');
  }
  return {
    ...batch,
    snapshot,
  };
}
export async function stageStoredDeliveryBatchArtifact(repository, storageRoot, publicId, actor, { signal } = {}) {
  const batch = await storedDeliveryBatchArtifact(repository, storageRoot, publicId, actor);
  const staged = await stageSnapshotBatchArchive(storageRoot, batch.snapshot, { signal });
  return { ...batch, ...staged };
}
export function recordDeliveryBatchDownload(repository, publicId, actor) {
  void repository.recordDeliveryBatchDownload(publicId, {
    actor
  }).catch(error => {
    console.error('failed to record delivery batch download', error);
  });
}
export async function loadDeliverySpreadsheetAsset(repository, storageRoot, task, assetId, signal, cachedAsset) {
  signal?.throwIfAborted();
  const asset = cachedAsset ?? (await repository.getAsset(assetId));
  signal?.throwIfAborted();
  const byteSize = Number(asset?.byteSize);
  const sha256 = String(asset?.sha256 ?? '').toLowerCase();
  if (!asset || Number(asset.id) !== Number(assetId) || Number(asset.taskId) !== Number(task.id) || !DELIVERY_IMAGE_MEDIA_TYPES.has(String(asset.mediaType)) || !Number.isSafeInteger(byteSize) || byteSize < 1 || byteSize > ASSET_BODY_LIMIT || !/^[a-f0-9]{64}$/u.test(sha256)) return null;
  const path = safeStoragePath(storageRoot, relative(storageRoot, asset.storagePath));
  const metadata = await stat(path).catch(error => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  signal?.throwIfAborted();
  if (!metadata?.isFile() || metadata.size !== byteSize) return null;
  const content = await readFile(path, {
    signal
  });
  signal?.throwIfAborted();
  if (createHash('sha256').update(content).digest('hex') !== sha256) return null;
  return {
    ...asset,
    content
  };
}
export async function hydrateDeliverySpreadsheetAssetSizes(repository, tasks, signal) {
  const assets = new Map();
  for (const task of tasks) {
    for (const assetId of deliverySpreadsheetAssetIds(task)) {
      signal?.throwIfAborted();
      const asset = await repository.getAsset(assetId);
      signal?.throwIfAborted();
      const byteSize = Number(asset?.byteSize);
      if (!asset || Number(asset.id) !== Number(assetId) || Number(asset.taskId) !== Number(task.id) || !DELIVERY_IMAGE_MEDIA_TYPES.has(String(asset.mediaType)) || !Number.isSafeInteger(byteSize) || byteSize < 1 || byteSize > ASSET_BODY_LIMIT) {
        throw new TypeError(`任务 ${task.id} 的交付图片缺失`);
      }
      const membership = task.assets?.find(candidate => Number(candidate.id) === Number(assetId) && String(candidate.imageRunId) === String(task.currentImageRunId));
      if (!membership) throw new TypeError(`任务 ${task.id} 的交付图片缺失`);
      membership.byteSize = byteSize;
      assets.set(Number(assetId), asset);
    }
  }
  return assets;
}
export async function stageDeliveryPoolSpreadsheet(repository, storageRoot, taskIds, {
  signal
} = {}) {
  if (taskIds.length > MAX_DELIVERY_SPREADSHEET_TASKS) {
    throw new ControlPlaneConflictError('DELIVERY_SPREADSHEET_TOO_LARGE', `Excel 图片导出一次最多 ${MAX_DELIVERY_SPREADSHEET_TASKS} 篇文章，请勾选后分批导出`);
  }
  const exportDirectory = safeStoragePath(storageRoot, DELIVERY_EXPORT_DIRECTORY, randomUUID());
  await mkdir(exportDirectory, {
    recursive: true
  });
  const bindings = [];
  try {
    const tasks = [];
    for (const taskId of taskIds) {
      signal?.throwIfAborted();
      const snapshot = await loadReadyDeliveryTask(repository, taskId);
      bindings.push(snapshot.binding);
      tasks.push(snapshot.task);
    }
    const assets = await hydrateDeliverySpreadsheetAssetSizes(repository, tasks, signal);
    const result = await writeDeliverySpreadsheetExport(tasks, (task, assetId) => loadDeliverySpreadsheetAsset(repository, storageRoot, task, assetId, signal, assets.get(Number(assetId))), exportDirectory, {
      signal,
      maxTasks: MAX_DELIVERY_SPREADSHEET_TASKS
    });
    return {
      spreadsheetPath: result.artifactPath,
      mediaType: result.mediaType,
      fileExtension: result.fileExtension,
      partCount: result.partCount,
      byteSize: (await stat(result.artifactPath)).size,
      taskCount: result.taskCount,
      bindings,
      cleanup: () => rm(exportDirectory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100
      })
    };
  } catch (error) {
    await rm(exportDirectory, {
      recursive: true,
      force: true
    }).catch(() => {});
    throw error;
  }
}
export async function stageDeliveryBatchSpreadsheet(repository, storageRoot, publicId, actor, {
  signal
} = {}) {
  if (typeof repository.getDeliveryBatchSpreadsheet !== 'function') {
    throw new ControlPlaneConflictError('FINAL_DELIVERY_UNAVAILABLE', '中心服务尚未支持历史批次 Excel，请升级后重试');
  }
  let snapshot;
  let frozenFiles = false;
  if (typeof repository.getDeliveryBatch === 'function') {
    const batch = await repository.getDeliveryBatch(publicId, { actor });
    const manifest = await loadDeliverySnapshot(storageRoot, batch.publicId);
    if (manifest.sourceArchive.sha256 !== batch.sha256 || manifest.sourceArchive.byteSize !== batch.byteSize) {
      throw new ControlPlaneConflictError('DELIVERY_BATCH_SOURCE_MISSING', '历史批次快照与交付记录不一致');
    }
    snapshot = { ...batch, tasks: buildSnapshotSpreadsheetTasks(manifest, batch.items),
      bindings: batch.items.map(item => ({ taskId: item.taskId, copyRevisionId: item.copyRevisionId, imageRunId: item.imageRunId })) };
    frozenFiles = true;
  } else {
    snapshot = await repository.getDeliveryBatchSpreadsheet(publicId, { actor });
  }
  if (!Array.isArray(snapshot?.tasks) || !Array.isArray(snapshot?.bindings) || snapshot.tasks.length !== snapshot.taskCount || snapshot.bindings.length !== snapshot.taskCount) {
    throw new ControlPlaneConflictError('DELIVERY_BATCH_SOURCE_MISSING', '该历史批次的冻结数据不完整，无法生成 Excel');
  }
  if (snapshot.taskCount > MAX_DELIVERY_SPREADSHEET_TASKS) {
    throw new ControlPlaneConflictError('DELIVERY_SPREADSHEET_TOO_LARGE', `Excel 图片导出一次最多 ${MAX_DELIVERY_SPREADSHEET_TASKS} 篇文章`);
  }
  const exportDirectory = safeStoragePath(storageRoot, DELIVERY_EXPORT_DIRECTORY, randomUUID());
  await mkdir(exportDirectory, {
    recursive: true
  });
  try {
    const assets = frozenFiles ? null : await hydrateDeliverySpreadsheetAssetSizes(repository, snapshot.tasks, signal);
    const loadAsset = frozenFiles ? async (task, assetId) => {
      const asset = task.assets.find(item => item.id === Number(assetId));
      if (!asset || asset.byteSize > ASSET_BODY_LIMIT) return null;
      const chunks = [];
      for await (const chunk of await openSnapshotFile(storageRoot, asset.snapshotFile, { signal })) chunks.push(chunk);
      return { ...asset, content: Buffer.concat(chunks) };
    } : (task, assetId) => loadDeliverySpreadsheetAsset(repository, storageRoot, task, assetId, signal, assets.get(Number(assetId)));
    const result = await writeDeliverySpreadsheetExport(snapshot.tasks, loadAsset, exportDirectory, {
      signal,
      maxTasks: MAX_DELIVERY_SPREADSHEET_TASKS
    });
    return {
      spreadsheetPath: result.artifactPath,
      mediaType: result.mediaType,
      fileExtension: result.fileExtension,
      partCount: result.partCount,
      byteSize: (await stat(result.artifactPath)).size,
      taskCount: result.taskCount,
      bindings: snapshot.bindings,
      batch: snapshot,
      cleanup: () => rm(exportDirectory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100
      })
    };
  } catch (error) {
    await rm(exportDirectory, {
      recursive: true,
      force: true
    }).catch(() => {});
    throw error;
  }
}
export function assertDeliveryExportArtifact(record, pathKey) {
  if (typeof record?.staged?.[pathKey] !== 'string') {
    throw new ControlPlaneNotFoundError('delivery export not found');
  }
  return record;
}
