import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { standaloneImageRunDirectory } from '../standalone-image-generation.mjs';

export async function readCheckpoint(path) {
  try {
    const bytes = await readFile(path);
    if (bytes.byteLength > 1_000_000) throw new Error('checkpoint is too large');
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function saveCheckpoint(path, value) {
  await writeFile(`${path}.tmp`, JSON.stringify(value), 'utf8');
  await rename(`${path}.tmp`, path);
}

export function imageRecoveryRunIds(execution, taskRoot) {
  const recovery = execution.snapshot.imageRecovery;
  if (!recovery) return [];
  if (!Array.isArray(recovery.runIds) || recovery.runIds.length === 0
    || (execution.nodeId && recovery.nodeId !== execution.nodeId)) {
    throw new Error('图片恢复记录无效，必须由保存检查点的原执行机继续');
  }
  for (const id of recovery.runIds) standaloneImageRunDirectory(taskRoot, id);
  return recovery.runIds;
}

export async function findImageRecoveryRun(taskRoot, runIds) {
  for (const id of runIds) {
    const directory = standaloneImageRunDirectory(taskRoot, id);
    if (!await readCheckpoint(join(directory, 'source.json'))) continue;
    const progress = await readCheckpoint(join(directory, 'progress.json'));
    if (!progress) continue;
    // An interrupted checkpoint copy has not started model work. Its parent
    // still contains the complete set of previously saved pages.
    if ((progress.stage === 'PREPARING' || progress.diagnostic?.stage === 'PREPARING')
      && id !== runIds.at(-1)) continue;
    return id;
  }
  throw new Error('原执行机上的图片检查点缺失，已停止恢复；请恢复本地工作目录后继续');
}

export async function loadUploadedImages(taskRoot, runIds) {
  const uploads = {};
  for (const id of [...runIds].reverse()) {
    const value = await readCheckpoint(join(standaloneImageRunDirectory(taskRoot, id), 'uploads.json'));
    for (const [file, entry] of Object.entries(value ?? {})) {
      if (/^\d{2}-[a-z][a-z0-9-]{0,30}\.png$/u.test(file)
        && /^[a-f0-9]{64}$/u.test(entry?.sha256 ?? '')
        && Number.isSafeInteger(entry?.asset?.id) && entry.asset.id > 0
        && entry.asset.url === `/v1/assets/${entry.asset.id}`) uploads[file] = entry;
    }
  }
  return uploads;
}
