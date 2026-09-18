import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';

import JSZip from 'jszip';

import { archiveFileName, buildBatchTaskArchive, buildTaskArchive, writeBatchTaskArchive } from '../src/task-archive.mjs';

test('configured archive includes only version-pinned delivery assets, excluding PNG previews, sources and historical runs', async () => {
  const task = { id: 1, currentCopyRevisionId: 1, currentImageRunId: 'new', copyRevisions: [{ id: 1, content: { copy: { title: '当前', body: '正文', tags: [] } } }],
    imageRuns: [{ id: 'new', result: { images: [{ assetId: 1, sourceAssetId: 2, deliveryAssetId: 3 }] } }],
    assets: [1, 2, 3, 4].map(id => ({ id, imageRunId: id === 4 ? 'old' : 'new', mediaType: id === 3 ? 'image/avif' : 'image/png' })) };
  const loaded = [];
  const archive = await buildTaskArchive(task, async id => { loaded.push(id); return { content: Buffer.from('delivery'), mediaType: 'image/avif', originalName: '01-hero.avif' }; });
  const zip = await JSZip.loadAsync(archive);
  assert.deepEqual(loaded, [3]);
  assert.deepEqual(Object.keys(zip.files).sort(), ['01-hero.avif', '当前.txt'].sort());
  task.assets = task.assets.filter(asset => asset.id !== 3);
  await assert.rejects(buildTaskArchive(task, async () => assert.fail('must not substitute a preview')), /资产缺失/);
});

test('manual archive ZIP contains current-run images under stable ordered names', async () => {
  const task = {
    id: 42,
    query: '桌面收纳',
    sourceQueryPackageName: '收纳/专题',
    xiaohongshuLinks: [
      { noteId: 'second', url: 'https://www.xiaohongshu.com/explore/second', title: null, rank: 2 },
      { noteId: 'first', url: 'https://www.xiaohongshu.com/explore/first', title: '第一篇参考', rank: 1 },
    ],
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
      originalName: id === 1 ? '01-cover.png' : 'delivery-e0227b68-1bbb-4b51-811a-bbef731b2732.png',
      content: Buffer.from(`image-${id}`),
    };
  });
  const zip = await JSZip.loadAsync(buffer);

  assert.equal(archiveFileName(task), '收纳_专题-桌面_整理-资源包.zip');
  assert.deepEqual(loadedIds, [1, 2]);
  assert.deepEqual(
    Object.keys(zip.files).sort(),
    ['01-cover.png', '02-edited.png', '小红书链接.txt', '桌面_整理.txt'].sort(),
  );
  assert.equal(await zip.file('01-cover.png').async('string'), 'image-1');
  const copy = await zip.file('桌面_整理.txt').async('string');
  assert.match(copy, /^\uFEFF原始 Query：桌面收纳/u);
  assert.match(copy, /标题：桌面\/整理/u);
  assert.match(copy, /文案内容：\r\n正文内容/u);
  assert.doesNotMatch(copy, /标签：|#收纳|#租房/u);
  const links = await zip.file('小红书链接.txt').async('string');
  assert.match(links, /^\uFEFFQuery：桌面收纳/u);
  assert.match(links, /1\. 第一篇参考\r\nhttps:\/\/www\.xiaohongshu\.com\/explore\/first/u);
  assert.match(links, /2\. https:\/\/www\.xiaohongshu\.com\/explore\/second/u);
  assert.ok(
    links.indexOf('/explore/first') < links.indexOf('/explore/second'),
    'links must be ordered by rank',
  );
  const emptyResultArchive = await buildTaskArchive({
    ...task,
    xiaohongshuLinks: [],
    xiaohongshuSearchStatus: 'SUCCEEDED',
  }, async (id) => ({
    id,
    mediaType: 'image/png',
    originalName: `${id}.png`,
    content: Buffer.from(`image-${id}`),
  }));
  const emptyResultZip = await JSZip.loadAsync(emptyResultArchive);
  assert.match(
    await emptyResultZip.file('小红书链接.txt').async('string'),
    /搜索状态：搜索完成，暂无结果[\s\S]*暂无可用链接/u,
  );
  const pendingResultArchive = await buildTaskArchive({
    ...task,
    xiaohongshuLinks: [],
    xiaohongshuSearchStatus: 'PENDING',
  }, async (id) => ({
    id,
    mediaType: 'image/png',
    originalName: `${id}.png`,
    content: Buffer.from(`image-${id}`),
  }));
  const pendingResultZip = await JSZip.loadAsync(pendingResultArchive);
  assert.match(
    await pendingResultZip.file('小红书链接.txt').async('string'),
    /搜索状态：等待搜索[\s\S]*暂无可用链接/u,
  );
});

test('delivery ZIP rejects a legacy TIFF binding instead of relabeling its bytes', async () => {
  const task = {
    id: 9,
    currentCopyRevisionId: 19,
    currentImageRunId: 'run-9',
    copyRevisions: [{ id: 19, content: { copy: { title: '标题', body: '', tags: [] } } }],
    imageRuns: [{ id: 'run-9', result: { images: [{ assetId: 29 }] } }],
    assets: [{ id: 29, imageRunId: 'run-9', mediaType: 'image/tiff' }],
  };
  await assert.rejects(
    buildTaskArchive(task, async () => assert.fail('TIFF must be rejected before reading bytes')),
    /资产缺失/u,
  );
});

test('manual archive ZIP prefixes repeated descriptive names with their page order', async () => {
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
  assert.ok(zip.file('01-封面图.jpg'));
  assert.ok(zip.file('02-封面图.jpg'));
});

test('batch archive groups task files directly under their shared client batch without nested ZIPs', async () => {
  const packageNames = new Map([[21, '分类/A'], [22, '分类\\A'], [23, null], [24, '分类/A']]);
  const clientBatchCodes = new Map([
    [21, 'b9759aad96a94c109fdce96ab4455294'],
    [22, 'b9759aad96a94c109fdce96ab4455294'],
    [23, null],
    [24, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
  ]);
  const tasks = [21, 22, 23, 24].map((id) => ({
    id,
    sourceQueryPackageName: packageNames.get(id),
    sourceClientBatchCode: clientBatchCodes.get(id),
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
  assert.deepEqual(Object.keys(outer.files).sort(), [
    'b9759aad96a94c109fdce96ab4455294/任务-21-资源包/标题21.txt',
    'b9759aad96a94c109fdce96ab4455294/任务-21-资源包/01-图片.png',
    'b9759aad96a94c109fdce96ab4455294/任务-22-资源包/标题22.txt',
    'b9759aad96a94c109fdce96ab4455294/任务-22-资源包/01-图片.png',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/任务-24-资源包/标题24.txt',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/任务-24-资源包/01-图片.png',
    '未归属甲方批次/任务-23-资源包/标题23.txt',
    '未归属甲方批次/任务-23-资源包/01-图片.png',
  ].sort());
  assert.equal(Object.keys(outer.files).some(name => name.endsWith('.zip')), false);
  for (const task of tasks) {
    const directory = `${task.sourceClientBatchCode ?? '未归属甲方批次'}/任务-${task.id}-资源包`;
    assert.equal(await outer.file(`${directory}/01-图片.png`).async('string'), String(task.id));
    assert.match(await outer.file(`${directory}/标题${task.id}.txt`).async('string'), /文案内容：\r\n正文/u);
  }
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

test('batch file streaming propagates image read failures and cancellation', { timeout: 5000 }, async () => {
  const task = {
    id: 1, currentCopyRevisionId: 1, currentImageRunId: 'run',
    copyRevisions: [{ id: 1, content: { copy: { title: '文案', body: '正文' } } }],
    imageRuns: [{ id: 'run', result: { images: [{ assetId: 1 }] } }],
    assets: [{ id: 1, imageRunId: 'run', mediaType: 'image/png' }],
  };
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    const error = new Error(cancel ? 'download cancelled' : 'image read failed');
    const stream = Readable.from((async function* () {
      yield Buffer.from('partial image');
      if (cancel) controller.abort(error);
      else throw error;
    })());
    const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    await assert.rejects(writeBatchTaskArchive([task], async () => ({
      mediaType: 'image/png', originalName: '01.png', content: stream,
    }), output, { signal: controller.signal }), cancel ? /cancelled|aborted/u : /image read failed/u);
    assert.equal(stream.destroyed, true);
    assert.equal(output.destroyed, true);
  }
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
