import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, link, mkdir, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';

const HARD_LINK_FALLBACK_CODES = new Set([
  'EACCES',
  'EMLINK',
  'ENOTSUP',
  'EPERM',
  'EXDEV',
]);

export async function materializeFile(sourcePath, destinationPath, {
  linkFile = link,
  copyFileExclusive = (source, destination) =>
    copyFile(source, destination, constants.COPYFILE_EXCL),
} = {}) {
  await mkdir(dirname(destinationPath), { recursive: true });
  try {
    await linkFile(sourcePath, destinationPath);
    return { mode: 'linked' };
  } catch (error) {
    if (!HARD_LINK_FALLBACK_CODES.has(error?.code)) throw error;
  }
  await copyFileExclusive(sourcePath, destinationPath);
  return { mode: 'copied' };
}

function safePath(root, child) {
  const rootPath = resolve(root);
  const path = resolve(rootPath, child);
  const relation = relative(rootPath, path);
  if (!relation || relation.startsWith('..') || isAbsolute(relation)) {
    throw new Error('storage path escaped its configured root');
  }
  return path;
}

function validAttemptDirectory(outputRoot, taskId, value) {
  if (typeof value !== 'string' || value === '') return null;
  const taskRoot = resolve(outputRoot, String(taskId));
  const path = resolve(value);
  const relation = relative(taskRoot, path);
  if (!relation || relation.startsWith('..') || isAbsolute(relation)
    || dirname(path) !== taskRoot || !/^attempt-\d+$/u.test(basename(path))) return null;
  return path;
}

function retainedAssetIds(task) {
  const assets = Array.isArray(task.assets) ? task.assets : [];
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const retained = new Set(
    assets.filter((asset) => asset.kind === 'EDITED').map((asset) => asset.id),
  );
  const currentByPage = new Map();
  const fallbackByPage = new Map();
  for (const asset of assets) {
    if (!['GENERATED', 'EDITED'].includes(asset.kind) || !Number.isInteger(asset.pageIndex)) continue;
    fallbackByPage.set(asset.pageIndex, asset.id);
    if (asset.sourceTextRevisionId === task.config?.currentTextRevisionId) {
      currentByPage.set(asset.pageIndex, asset.id);
    }
  }
  const imageCount = Number.isInteger(task.config?.imageCount) ? task.config.imageCount : 5;
  for (let pageIndex = 1; pageIndex <= imageCount; pageIndex += 1) {
    const assetId = currentByPage.get(pageIndex) ?? fallbackByPage.get(pageIndex);
    if (assetId) retained.add(assetId);
  }
  const pending = [...retained];
  while (pending.length > 0) {
    const asset = byId.get(pending.pop());
    if (!asset?.parentAssetId || retained.has(asset.parentAssetId)) continue;
    retained.add(asset.parentAssetId);
    pending.push(asset.parentAssetId);
  }
  return retained;
}

async function imageFiles(directory) {
  const files = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return files;
    throw error;
  }
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await imageFiles(path));
    else if (entry.isFile() && /\.(?:jpe?g|png|webp)$/iu.test(entry.name)) files.push(path);
  }
  return files;
}

async function checkpointImagePaths(outputRoot, taskId) {
  let raw;
  try {
    raw = await readFile(safePath(outputRoot, `${Number(taskId)}/checkpoint.json`), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return new Set();
    throw error;
  }
  if (Buffer.byteLength(raw, 'utf8') > 500_000) return new Set();
  let checkpoint;
  try {
    checkpoint = JSON.parse(raw);
  } catch {
    return new Set();
  }
  const taskRoot = resolve(outputRoot, String(taskId));
  const paths = new Set();
  for (const image of Array.isArray(checkpoint?.images) ? checkpoint.images : []) {
    if (typeof image?.relativePath !== 'string') continue;
    try {
      const path = safePath(outputRoot, image.relativePath);
      const relationToTask = relative(taskRoot, path);
      if (relationToTask && !relationToTask.startsWith('..') && !isAbsolute(relationToTask)) {
        paths.add(path);
      }
    } catch {
      // Invalid checkpoint paths are ignored just as the pipeline ignores unusable checkpoints.
    }
  }
  return paths;
}

async function fileSize(path) {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
}

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function originalGeneratedFileName(asset) {
  const match = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-(.+)$/iu
    .exec(asset.fileName ?? '');
  return match?.[1] && basename(match[1]) === match[1] ? match[1] : null;
}

async function replaceWithHardLink(sourcePath, destinationPath) {
  const temporaryPath = `${destinationPath}.hardlink-${randomUUID()}.tmp`;
  await link(sourcePath, temporaryPath);
  try {
    await rename(temporaryPath, destinationPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

function errorDetail(operation, path, error) {
  return {
    operation,
    path,
    error: error instanceof Error ? error.message : String(error),
  };
}

export async function optimizeTaskStorage({
  store,
  taskId,
  assetRoot,
  outputRoot,
  apply = false,
}) {
  const task = store?.getTask?.(taskId);
  if (!task?.config) throw new Error(`task ${taskId} was not found`);
  if (apply && typeof store.deleteAssetsForRetention !== 'function') {
    throw new TypeError('store.deleteAssetsForRetention is required when applying cleanup');
  }
  const retained = retainedAssetIds(task);
  const assetsToDelete = task.assets.filter(
    (asset) => asset.kind === 'GENERATED' && !retained.has(asset.id),
  );
  const errors = [];
  const assetFiles = [];
  for (const asset of assetsToDelete) {
    try {
      const path = safePath(assetRoot, asset.relativePath);
      assetFiles.push({ asset, path, bytes: await fileSize(path) });
    } catch (error) {
      errors.push(errorDetail('plan_asset_delete', asset.relativePath, error));
    }
  }

  const validRuns = task.generationRuns
    .map((run) => ({ ...run, validOutputDir: validAttemptDirectory(outputRoot, taskId, run.outputDir) }))
    .filter((run) => run.validOutputDir);
  const latestRun = validRuns.at(-1) ?? null;
  const historicalDirectories = [...new Set(
    validRuns.slice(0, -1)
      .map((run) => run.validOutputDir)
      .filter((directory) => directory !== latestRun?.validOutputDir),
  )];
  const outputFiles = [];
  let checkpointImages = null;
  try {
    checkpointImages = await checkpointImagePaths(outputRoot, taskId);
  } catch (error) {
    errors.push(errorDetail('read_checkpoint', String(taskId), error));
  }
  if (checkpointImages) {
    for (const directory of historicalDirectories) {
      try {
        for (const path of await imageFiles(directory)) {
          if (!checkpointImages.has(path)) {
            outputFiles.push({ path, bytes: await fileSize(path) });
          }
        }
      } catch (error) {
        errors.push(errorDetail('plan_output_delete', directory, error));
      }
    }
  }

  const runByAttempt = new Map(validRuns.map((run) => [run.attempt, run]));
  const linkCandidates = [];
  for (const asset of task.assets) {
    if (asset.kind !== 'GENERATED' || !retained.has(asset.id)) continue;
    const normalized = String(asset.relativePath ?? '').replaceAll('\\', '/');
    const attemptMatch = new RegExp(`^generated/${Number(taskId)}/attempt-(\\d+)/`, 'u').exec(normalized);
    const run = attemptMatch ? runByAttempt.get(Number(attemptMatch[1])) : null;
    if (!run || run.validOutputDir !== latestRun?.validOutputDir) continue;
    const originalName = originalGeneratedFileName(asset);
    if (!originalName) continue;
    try {
      const sourcePath = safePath(run.validOutputDir, originalName);
      const destinationPath = safePath(assetRoot, asset.relativePath);
      const [sourceStat, destinationStat] = await Promise.all([stat(sourcePath), stat(destinationPath)]);
      if (sourceStat.dev === destinationStat.dev && sourceStat.ino === destinationStat.ino) continue;
      const [sourceHash, destinationHash] = await Promise.all([
        hashFile(sourcePath),
        hashFile(destinationPath),
      ]);
      if (sourceHash !== asset.sha256 || destinationHash !== asset.sha256) {
        throw new Error('generated asset content did not match its recorded SHA-256');
      }
      linkCandidates.push({ asset, sourcePath, destinationPath, bytes: destinationStat.size });
    } catch (error) {
      errors.push(errorDetail('plan_hard_link', asset.relativePath, error));
    }
  }

  const result = {
    taskId: Number(taskId),
    apply: Boolean(apply),
    assets: {
      deleteCount: assetFiles.length,
      deleteBytes: assetFiles.reduce((total, file) => total + file.bytes, 0),
      deletedCount: 0,
    },
    outputImages: {
      deleteCount: outputFiles.length,
      deleteBytes: outputFiles.reduce((total, file) => total + file.bytes, 0),
      deletedCount: 0,
    },
    deduplication: {
      linkCount: linkCandidates.length,
      linkBytes: linkCandidates.reduce((total, file) => total + file.bytes, 0),
      linkedCount: 0,
    },
    errors,
  };
  if (!apply) return result;

  for (const candidate of linkCandidates) {
    try {
      await replaceWithHardLink(candidate.sourcePath, candidate.destinationPath);
      result.deduplication.linkedCount += 1;
    } catch (error) {
      errors.push(errorDetail('apply_hard_link', candidate.destinationPath, error));
    }
  }

  let deletedAssets = [];
  if (assetFiles.length > 0) {
    try {
      deletedAssets = await store.deleteAssetsForRetention(
        Number(taskId),
        assetFiles.map(({ asset }) => asset.id),
      );
    } catch (error) {
      errors.push(errorDetail('delete_asset_rows', String(taskId), error));
    }
  }
  const deletedAssetIds = new Set(deletedAssets.map((asset) => asset.id));
  for (const file of assetFiles) {
    if (!deletedAssetIds.has(file.asset.id)) continue;
    try {
      await unlink(file.path).catch((error) => {
        if (error?.code !== 'ENOENT') throw error;
      });
      result.assets.deletedCount += 1;
    } catch (error) {
      errors.push(errorDetail('delete_asset_file', file.path, error));
    }
  }
  for (const file of outputFiles) {
    try {
      await unlink(file.path).catch((error) => {
        if (error?.code !== 'ENOENT') throw error;
      });
      result.outputImages.deletedCount += 1;
    } catch (error) {
      errors.push(errorDetail('delete_output_image', file.path, error));
    }
  }
  return result;
}

export async function optimizeAllTaskStorage({
  store,
  assetRoot,
  outputRoot,
  apply = false,
  optimizeTask = optimizeTaskStorage,
}) {
  if (typeof store?.listTasks !== 'function') throw new TypeError('store.listTasks is required');
  const reports = [];
  let page = 1;
  let totalPages = 1;
  do {
    const result = store.listTasks({ page, pageSize: 100 });
    totalPages = Math.max(1, Number(result?.pagination?.totalPages) || 1);
    for (const task of result?.data ?? []) {
      reports.push(await optimizeTask({
        store,
        taskId: task.id,
        assetRoot,
        outputRoot,
        apply,
      }));
    }
    page += 1;
  } while (page <= totalPages);

  const sum = (selector) => reports.reduce((total, report) => total + selector(report), 0);
  return {
    apply: Boolean(apply),
    taskCount: reports.length,
    assets: {
      deleteCount: sum((report) => report.assets.deleteCount),
      deleteBytes: sum((report) => report.assets.deleteBytes),
      deletedCount: sum((report) => report.assets.deletedCount),
    },
    outputImages: {
      deleteCount: sum((report) => report.outputImages.deleteCount),
      deleteBytes: sum((report) => report.outputImages.deleteBytes),
      deletedCount: sum((report) => report.outputImages.deletedCount),
    },
    deduplication: {
      linkCount: sum((report) => report.deduplication.linkCount),
      linkBytes: sum((report) => report.deduplication.linkBytes),
      linkedCount: sum((report) => report.deduplication.linkedCount),
    },
    logicalBytes: sum((report) =>
      report.assets.deleteBytes
      + report.outputImages.deleteBytes
      + report.deduplication.linkBytes),
    errors: reports.flatMap((report) =>
      report.errors.map((error) => ({ taskId: report.taskId, ...error }))),
    tasks: reports,
  };
}
