import assert from 'node:assert/strict';
import test from 'node:test';

import JSZip from 'jszip';

import { archiveFileName, buildTaskArchive } from '../src/task-archive.mjs';

test('manual archive ZIP contains the current copy and current-run images under their original names', async () => {
  const task = {
    id: 42,
    currentCopyRevisionId: 8,
    currentImageRunId: 'run-current',
    copyRevisions: [
      { id: 8, content: { copy: { title: '桌面/整理', body: '正文内容', tags: ['#收纳', '#租房'] } } },
      { id: 7, content: { copy: { title: '旧标题', body: '旧正文', tags: [] } } },
    ],
    assets: [
      { id: 1, imageRunId: 'run-current', mediaType: 'image/png' },
      { id: 2, imageRunId: 'run-current', mediaType: 'image/png' },
      { id: 3, imageRunId: 'run-old', mediaType: 'image/png' },
      { id: 4, imageRunId: 'run-current', mediaType: 'application/json' },
    ],
  };
  const loadedIds = [];
  const buffer = await buildTaskArchive(task, async (id) => {
    loadedIds.push(id);
    return {
      id,
      mediaType: 'image/png',
      originalName: id === 1 ? '01-cover.png' : '02-detail.png',
      content: Buffer.from(`image-${id}`),
    };
  });
  const zip = await JSZip.loadAsync(buffer);

  assert.equal(archiveFileName(task), '桌面_整理-资源包.zip');
  assert.deepEqual(loadedIds, [1, 2]);
  assert.deepEqual(Object.keys(zip.files).sort(), ['01-cover.png', '02-detail.png', '桌面_整理.txt'].sort());
  assert.equal(await zip.file('01-cover.png').async('string'), 'image-1');
  const copy = await zip.file('桌面_整理.txt').async('string');
  assert.match(copy, /^\uFEFF标题：桌面\/整理/u);
  assert.match(copy, /文案内容：\r\n正文内容/u);
  assert.match(copy, /标签：#收纳 #租房/u);
});

test('manual archive ZIP de-duplicates repeated image names without using storage hashes', async () => {
  const task = {
    id: 9,
    currentCopyRevisionId: 1,
    currentImageRunId: 'run',
    copyRevisions: [{ id: 1, content: { copy: { title: '标题', body: '正文', tags: [] } } }],
    assets: [
      { id: 1, imageRunId: 'run', mediaType: 'image/jpeg' },
      { id: 2, imageRunId: 'run', mediaType: 'image/jpeg' },
    ],
  };
  const buffer = await buildTaskArchive(task, async (id) => ({
    id,
    mediaType: 'image/jpeg',
    originalName: '封面图.jpg',
    content: Buffer.from([id]),
  }));
  const zip = await JSZip.loadAsync(buffer);
  assert.ok(zip.file('封面图.jpg'));
  assert.ok(zip.file('封面图-2.jpg'));
});
