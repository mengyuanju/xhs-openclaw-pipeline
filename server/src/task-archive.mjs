import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { ZipArchive } from 'archiver';
import JSZip from 'jszip';
import {
  deliveryCopyFromContent,
  resolveDeliveryArchiveSource,
} from './delivery-source.mjs';
import { IMAGE_FORMATS } from './image-options.mjs';

function safeFileName(value, fallback) {
  const clean = (candidate) => String(candidate ?? '')
    .replace(/[\u0000-\u001f<>:"/\\|?*]/gu, '_')
    .replace(/[. ]+$/gu, '')
    .trim();
  return [...(clean(value) || clean(fallback) || '文件')].slice(0, 120).join('');
}

export function queryPackageFileNameSegment(value) {
  return safeFileName(value, '未归属词包');
}

function uniqueFileName(name, used) {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  let candidate = name;
  let suffix = 2;
  while (used.has(candidate.toLocaleLowerCase('zh-CN'))) {
    candidate = `${stem}-${suffix}${extension}`;
    suffix += 1;
  }
  used.add(candidate.toLocaleLowerCase('zh-CN'));
  return candidate;
}

function currentCopy(task) {
  const revision = task.copyRevisions.find((item) => item.id === task.currentCopyRevisionId);
  return deliveryCopyFromContent(revision?.content);
}

function singleLine(value) {
  return String(value ?? '')
    .replace(/[\r\n]+/gu, ' ')
    .replace(/[\u0000-\u001f\u007f]/gu, '\uFFFD')
    .trim();
}

function rankedXiaohongshuLinks(task) {
  if (!Array.isArray(task?.xiaohongshuLinks)) return [];
  return task.xiaohongshuLinks
    .map((item, index) => ({
      index,
      rank: Number.isSafeInteger(Number(item?.rank)) && Number(item.rank) > 0
        ? Number(item.rank)
        : index + 1,
      title: singleLine(item?.title),
      url: singleLine(item?.url),
    }))
    .filter((item) => item.url)
    .sort((left, right) => left.rank - right.rank || left.index - right.index);
}

function xiaohongshuSearchStatusText(task, links) {
  if (links.length > 0) return `已完成（${links.length} 条）`;
  if (task?.xiaohongshuSearchStatus === 'PENDING') return '等待搜索';
  if (task?.xiaohongshuSearchStatus === 'RUNNING') return '搜索中';
  if (task?.xiaohongshuSearchStatus === 'BLOCKED') {
    return task.xiaohongshuSearchBlockedReason === 'CAPTCHA_REQUIRED'
      ? '等待人工安全验证'
      : '等待重新登录';
  }
  if (task?.xiaohongshuSearchStatus === 'FAILED') return '搜索失败';
  if (task?.xiaohongshuSearchStatus === 'CANCELLED') return '搜索已取消';
  if (task?.xiaohongshuSearchStatus === 'SUCCEEDED') return '搜索完成，暂无结果';
  return '未建立搜索记录';
}

function xiaohongshuLinksText(task, links) {
  const entries = links.flatMap((item) => item.title
    ? [`${item.rank}. ${item.title}`, item.url, '']
    : [`${item.rank}. ${item.url}`, '']);
  const body = entries.length > 0 ? entries.join('\r\n').trimEnd() : '暂无可用链接';
  return `\uFEFFQuery：${singleLine(task.query)}\r\n搜索状态：${xiaohongshuSearchStatusText(task, links)}\r\n\r\n小红书链接：\r\n${body}\r\n`;
}

function assertXiaohongshuSearchReady(task) {
  if (task?.xiaohongshuSearchStatus && task.xiaohongshuSearchStatus !== 'SUCCEEDED') {
    throw new TypeError('当前 Query 的小红书搜索尚未完成，不能导出交付文件');
  }
}

export function archiveFileName(task) {
  const title = safeFileName(currentCopy(task)?.title, `任务-${task.id}`);
  const label = `${queryPackageFileNameSegment(task.sourceQueryPackageName)}-${title}`;
  return `${safeFileName(label, `任务-${task.id}`)}-资源包.zip`;
}

async function createTaskArchiveZip(task, loadAsset) {
  assertXiaohongshuSearchReady(task);
  const revision = task.copyRevisions.find((item) => item.id === task.currentCopyRevisionId);
  const run = task.imageRuns?.find(item => item.id === task.currentImageRunId);
  const candidates = task.assets.filter((asset) => asset.imageRunId === task.currentImageRunId
    && String(asset.mediaType).startsWith('image/'));
  const { copy, assetIds } = resolveDeliveryArchiveSource({
    content: revision?.content,
    imageResult: run?.result,
    availableAssetIds: candidates.map((asset) => asset.id),
  });
  const assets = assetIds.map((id) => candidates.find((item) => Number(item.id) === id));

  const zip = new JSZip();
  const title = String(copy.title ?? '').trim();
  const body = String(copy.body ?? '').trim();
  const tags = Array.isArray(copy.tags) ? copy.tags.map(String).join(' ') : '';
  const text = `\uFEFF标题：${title}\r\n\r\n文案内容：\r\n${body}\r\n\r\n标签：${tags}\r\n`;
  const usedNames = new Set();
  zip.file(uniqueFileName(`${safeFileName(title, `任务-${task.id}`)}.txt`, usedNames), text);
  const xiaohongshuLinks = rankedXiaohongshuLinks(task);
  if (xiaohongshuLinks.length > 0 || task.xiaohongshuSearchStatus) {
    zip.file(
      uniqueFileName('小红书链接.txt', usedNames),
      xiaohongshuLinksText(task, xiaohongshuLinks),
    );
  }

  for (let index = 0; index < assets.length; index += 1) {
    const asset = assets[index];
    const loaded = await loadAsset(asset.id);
    if (!loaded) throw new TypeError(`asset ${asset.id} is missing`);
    const extension = `.${Object.values(IMAGE_FORMATS).find(format => format.mediaType === loaded.mediaType)?.extension ?? 'png'}`;
    const requestedName = safeFileName(loaded.originalName, `图片-${index + 1}${extension}`);
    const name = /\.[a-z0-9]{2,5}$/iu.test(requestedName) ? requestedName : `${requestedName}${extension}`;
    zip.file(uniqueFileName(name, usedNames), loaded.content);
  }

  return zip;
}

export async function buildTaskArchive(task, loadAsset) {
  const zip = await createTaskArchiveZip(task, loadAsset);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

function assertBatchTasks(tasks, maxTasks) {
  if (!Array.isArray(tasks) || tasks.length < 1
      || (Number.isFinite(maxTasks) && tasks.length > maxTasks)) {
    throw new RangeError(Number.isFinite(maxTasks)
      ? `batch archive must contain between 1 and ${maxTasks} tasks`
      : 'batch archive must contain at least 1 task');
  }
}

function waitForArchiveEntry(archive, output, signal) {
  return new Promise((resolve, reject) => {
    function cleanup() {
      archive.off('entry', onEntry);
      archive.off('error', onError);
      output.off('error', onError);
      signal?.removeEventListener('abort', onAbort);
    }
    function onEntry() {
      cleanup();
      resolve();
    }
    function onError(error) {
      cleanup();
      reject(error);
    }
    function onAbort() {
      onError(signal.reason ?? new Error('archive generation was cancelled'));
    }
    archive.once('entry', onEntry);
    archive.once('error', onError);
    output.once('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Streams an outer ZIP64 archive while loading one task snapshot at a time.
 * This keeps a full-delivery export bounded by one task's metadata and assets.
 */
export async function writeBatchTaskArchive(tasks, loadAsset, output, {
  maxTasks = 20,
  signal,
} = {}) {
  if (!tasks || typeof tasks[Symbol.asyncIterator] !== 'function'
      && typeof tasks[Symbol.iterator] !== 'function') {
    throw new TypeError('batch archive tasks must be iterable');
  }
  const archive = new ZipArchive({
    forceZip64: true,
    zlib: { level: 0 },
  });
  const unassignedPackageDirectory = queryPackageFileNameSegment(null);
  const packageDirectories = new Map([['', unassignedPackageDirectory]]);
  const usedPackageDirectories = new Set([
    unassignedPackageDirectory.toLocaleLowerCase('zh-CN'),
  ]);

  function packageDirectory(task) {
    const packageName = String(task?.sourceQueryPackageName ?? '');
    if (packageDirectories.has(packageName)) return packageDirectories.get(packageName);
    const base = queryPackageFileNameSegment(packageName);
    let candidate = base;
    let suffix = 2;
    while (usedPackageDirectories.has(candidate.toLocaleLowerCase('zh-CN'))) {
      const ending = `-${suffix}`;
      candidate = `${[...base].slice(0, 120 - ending.length).join('')}${ending}`;
      suffix += 1;
    }
    usedPackageDirectories.add(candidate.toLocaleLowerCase('zh-CN'));
    packageDirectories.set(packageName, candidate);
    return candidate;
  }
  let transferError = null;
  const transfer = pipeline(archive, output, { signal }).catch((error) => {
    transferError = error;
  });
  let taskCount = 0;
  try {
    for await (const task of tasks) {
      signal?.throwIfAborted();
      taskCount += 1;
      if (Number.isFinite(maxTasks) && taskCount > maxTasks) {
        throw new RangeError(`batch archive must contain between 1 and ${maxTasks} tasks`);
      }
      if (transferError) throw transferError;
      const taskZip = await createTaskArchiveZip(
        task,
        (assetId) => loadAsset(task, assetId),
      );
      signal?.throwIfAborted();
      const entryWritten = waitForArchiveEntry(archive, output, signal);
      archive.append(taskZip.generateNodeStream({
        type: 'nodebuffer',
        streamFiles: true,
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
      }), {
        name: `${packageDirectory(task)}/${safeFileName(`任务-${task.id}-资源包`, '任务-资源包')}.zip`,
        store: true,
      });
      await entryWritten;
    }
    if (taskCount === 0) throw new RangeError('batch archive must contain at least 1 task');
    signal?.throwIfAborted();
    await archive.finalize();
    await transfer;
    if (transferError) throw transferError;
    return { taskCount };
  } catch (error) {
    archive.abort();
    if (!output.destroyed) output.destroy(error);
    await transfer;
    throw error;
  }
}

export async function createBatchTaskArchiveStream(tasks, loadAsset, { maxTasks = 20 } = {}) {
  assertBatchTasks(tasks, maxTasks);
  const output = new PassThrough();
  void writeBatchTaskArchive(tasks, loadAsset, output, { maxTasks }).catch((error) => {
    if (!output.destroyed) output.destroy(error);
  });
  return output;
}

export async function buildBatchTaskArchive(tasks, loadAsset) {
  const stream = await createBatchTaskArchiveStream(tasks, loadAsset);
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.once('end', () => resolve(Buffer.concat(chunks)));
    stream.once('error', reject);
  });
}
