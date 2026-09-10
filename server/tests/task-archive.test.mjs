import assert from 'node:assert/strict';
import test from 'node:test';

import JSZip from 'jszip';

import { archiveFileName, buildBatchTaskArchive, buildTaskArchive } from '../src/task-archive.mjs';

test('configured archive includes only version-pinned delivery assets, excluding PNG previews, sources and historical runs', async () => {
  const task = { id: 1, currentCopyRevisionId: 1, currentImageRunId: 'new', copyRevisions: [{ id: 1, content: { copy: { title: '当前', body: '正文', tags: [] } } }],
    imageRuns: [{ id: 'new', result: { images: [{ assetId: 1, sourceAssetId: 2, deliveryAssetId: 3 }] } }],
    assets: [1, 2, 3, 4].map(id => ({ id, imageRunId: id === 4 ? 'old' : 'new', mediaType: id === 3 ? 'image/tiff' : 'image/png' })) };
  const loaded = [];
  const archive = await buildTaskArchive(task, async id => { loaded.push(id); return { content: Buffer.from('delivery'), mediaType: 'image/tiff', originalName: '01-hero.tiff' }; });
  const zip = await JSZip.loadAsync(archive);
  assert.deepEqual(loaded, [3]);
  assert.deepEqual(Object.keys(zip.files).sort(), ['01-hero.tiff', '当前.txt'].sort());
  task.assets = task.assets.filter(asset => asset.id !== 3);
  await assert.rejects(buildTaskArchive(task, async () => assert.fail('must not substitute a preview')), /资产缺失/);
});

test('manual archive ZIP contains the current copy and current-run images under their original names', async () => {
  const task = {
    id: 42,
    currentCopyRevisionId: 8,
    currentImageRunId: 'run-current',
    copyRevisions: [
      { id: 8, content: { copy: { title: '桌面/整理', body: '正文内容', tags: ['#收纳', '#租房'] } } },
      { id: 7, content: { copy: { title: '旧标题', body: '旧正文', tags: [] } } },
    ],
    imageRuns: [{ id: 'run-current', result: { images: [{ assetId: 1 }, { assetId: 2 }] } }],
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
    imageRuns: [{ id: 'run', result: { images: [{ assetId: 1 }, { assetId: 2 }] } }],
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

test('batch archive keeps each task resource package separate', async () => {
  const tasks = [21, 22].map((id) => ({
    id,
    currentCopyRevisionId: 1,
    currentImageRunId: `run-${id}`,
    copyRevisions: [{ id: 1, content: { copy: { title: `标题${id}`, body: '正文', tags: [] } } }],
    imageRuns: [{ id: `run-${id}`, result: { images: [{ assetId: id }] } }],
    assets: [{ id, taskId: id, imageRunId: `run-${id}`, mediaType: 'image/png' }],
  }));
  const content = await buildBatchTaskArchive(tasks, async (task, assetId) => ({
    id: assetId, taskId: task.id, mediaType: 'image/png', originalName: '图片.png', content: Buffer.from(String(task.id)),
  }));
  assert.ok(content.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06])),
    'the outer archive must carry a ZIP64 end-of-central-directory record');
  const outer = await JSZip.loadAsync(content);
  assert.deepEqual(Object.keys(outer.files).sort(), ['任务-21-资源包.zip', '任务-22-资源包.zip']);
  const inner = await JSZip.loadAsync(await outer.file('任务-21-资源包.zip').async('nodebuffer'));
  assert.equal(await inner.file('图片.png').async('string'), '21');
});

test('delivery archive fails closed when the pinned copy or image snapshot is missing', async () => {
  const task = {
    id: 31,
    currentCopyRevisionId: 9,
    currentImageRunId: 'run-31',
    copyRevisions: [{ id: 8, content: { copy: { title: '旧文案', body: '正文', tags: [] } } }],
    imageRuns: [{ id: 'run-31', result: { images: [{ assetId: 31 }] } }],
    assets: [{ id: 31, imageRunId: 'run-31', mediaType: 'image/png' }],
  };
  await assert.rejects(buildTaskArchive(task, async () => assert.fail('must not read assets')), /当前交付文案版本缺失/u);
  task.copyRevisions = [{ id: 9, content: { copy: { title: '当前文案', body: '正文', tags: [] } } }];
  task.imageRuns = [];
  await assert.rejects(buildTaskArchive(task, async () => assert.fail('must not read assets')), /当前交付图片版本缺失/u);
});

test('delivery archive keeps migrated post-shaped copy content compatible', async () => {
  const task = {
    id: 41,
    currentCopyRevisionId: 19,
    currentImageRunId: 'run-41',
    copyRevisions: [{
      id: 19,
      content: { post: { title: '迁移文案', body: '兼容正文', tags: ['#旧数据'] } },
    }],
    imageRuns: [{ id: 'run-41', result: { images: [{ assetId: 41 }] } }],
    assets: [{ id: 41, imageRunId: 'run-41', mediaType: 'image/png' }],
  };
  const content = await buildTaskArchive(task, async () => ({
    mediaType: 'image/png', originalName: '旧图.png', content: Buffer.from('image'),
  }));
  const zip = await JSZip.loadAsync(content);
  assert.ok(zip.file('迁移文案.txt'));
  assert.match(await zip.file('迁移文案.txt').async('string'), /兼容正文/u);
});
