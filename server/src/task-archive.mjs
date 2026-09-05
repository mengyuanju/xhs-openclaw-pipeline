import JSZip from 'jszip';

function safeFileName(value, fallback) {
  const cleaned = String(value ?? '')
    .replace(/[\u0000-\u001f<>:"/\\|?*]/gu, '_')
    .replace(/[. ]+$/gu, '')
    .trim();
  return [...(cleaned || fallback)].slice(0, 120).join('');
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
  const revision = task.copyRevisions.find((item) => item.id === task.currentCopyRevisionId)
    ?? task.copyRevisions[0];
  return revision?.content?.copy ?? revision?.content?.reviewed?.copy ?? null;
}

export function archiveFileName(task) {
  const title = safeFileName(currentCopy(task)?.title, `任务-${task.id}`);
  return `${title}-资源包.zip`;
}

export async function buildTaskArchive(task, loadAsset) {
  const copy = currentCopy(task);
  if (!copy) throw new TypeError('task has no copy content to archive');
  const assets = task.assets.filter((asset) => asset.imageRunId === task.currentImageRunId
    && String(asset.mediaType).startsWith('image/'));
  if (assets.length === 0) throw new TypeError('task has no generated images to archive');

  const zip = new JSZip();
  const title = String(copy.title ?? '').trim();
  const body = String(copy.body ?? '').trim();
  const tags = Array.isArray(copy.tags) ? copy.tags.map(String).join(' ') : '';
  const text = `\uFEFF标题：${title}\r\n\r\n文案内容：\r\n${body}\r\n\r\n标签：${tags}\r\n`;
  zip.file(`${safeFileName(title, `任务-${task.id}`)}.txt`, text);

  const usedNames = new Set();
  for (let index = 0; index < assets.length; index += 1) {
    const asset = assets[index];
    const loaded = await loadAsset(asset.id);
    if (!loaded) throw new TypeError(`asset ${asset.id} is missing`);
    const extension = loaded.mediaType === 'image/jpeg' ? '.jpg' : '.png';
    const requestedName = safeFileName(loaded.originalName, `图片-${index + 1}${extension}`);
    const name = /\.[a-z0-9]{2,5}$/iu.test(requestedName) ? requestedName : `${requestedName}${extension}`;
    zip.file(uniqueFileName(name, usedNames), loaded.content);
  }

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
