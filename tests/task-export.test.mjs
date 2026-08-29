import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import JSZip from 'jszip';

import {
  buildTaskBatchExportArchive,
  buildTaskExportArchive,
  getTaskExportAvailability,
  MAX_BATCH_EXPORT_TASKS,
} from '../src/admin/task-export.mjs';

function approvedTask(overrides = {}) {
  return {
    id: overrides.id ?? 42,
    query: overrides.query ?? '周末北海一日游',
    config: {
      externalId: 'xhs-42',
      imageCount: 3,
      reviewStatus: 'APPROVED',
      ...overrides.config,
    },
    currentTextRevision: {
      id: 9,
      title: '北海一日游路线',
      body: '早上逛老街，下午看日落。',
      tags: ['#北海旅游', '#周末去哪儿'],
      createdAt: '2026-08-25T01:00:00.000Z',
      ...overrides.currentTextRevision,
    },
    assets: overrides.assets ?? [],
  };
}

function deliveryAsset({ id, pageIndex, relativePath, revision = id, alignmentStatus = 'PASSED' }) {
  return {
    id,
    kind: 'GENERATED',
    revision,
    fileName: `page-${pageIndex}.png`,
    relativePath,
    mimeType: 'image/png',
    sha256: String(id).padStart(64, '0'),
    sourceTextRevisionId: 9,
    pageIndex,
    alignmentStatus,
  };
}

describe('task export archive', () => {
  it('exports the approved current copy and latest aligned image for every page', async () => {
    const assetRoot = await mkdtemp(join(tmpdir(), 'xhs-task-export-'));
    try {
      await mkdir(join(assetRoot, '42'), { recursive: true });
      await Promise.all([
        writeFile(join(assetRoot, '42', 'page-1-old.png'), Buffer.from('old-page-1')),
        writeFile(join(assetRoot, '42', 'page-1.png'), Buffer.from('new-page-1')),
        writeFile(join(assetRoot, '42', 'page-2.png'), Buffer.from('page-2')),
        writeFile(join(assetRoot, '42', 'page-3.png'), Buffer.from('page-3')),
      ]);
      const task = approvedTask({
        assets: [
          deliveryAsset({ id: 1, pageIndex: 1, relativePath: '42/page-1-old.png' }),
          deliveryAsset({ id: 4, pageIndex: 3, relativePath: '42/page-3.png' }),
          deliveryAsset({ id: 3, pageIndex: 2, relativePath: '42/page-2.png' }),
          deliveryAsset({ id: 5, pageIndex: 1, relativePath: '42/page-1.png' }),
          { ...deliveryAsset({ id: 6, pageIndex: 2, relativePath: '42/page-2.png' }), sourceTextRevisionId: 8 },
          { ...deliveryAsset({ id: 7, pageIndex: 3, relativePath: '42/page-3.png' }), kind: 'REFERENCE' },
        ],
      });

      const result = await buildTaskExportArchive({
        task,
        assetRoot,
        exportedAt: new Date('2026-08-25T02:03:04.000Z'),
      });
      const archive = await JSZip.loadAsync(result.buffer);

      assert.equal(result.fileName, 'xhs-task-42.zip');
      assert.deepEqual(Object.keys(archive.files).sort(), [
        'content.txt',
        'images/',
        'images/01.png',
        'images/02.png',
        'images/03.png',
        'metadata.json',
      ]);
      assert.equal(await archive.file('content.txt').async('string'), [
        '标题',
        '北海一日游路线',
        '',
        '正文',
        '早上逛老街，下午看日落。',
        '',
        '标签',
        '#北海旅游 #周末去哪儿',
        '',
      ].join('\n'));
      assert.deepEqual(JSON.parse(await archive.file('metadata.json').async('string')), {
        taskId: 42,
        externalId: 'xhs-42',
        query: '周末北海一日游',
        title: '北海一日游路线',
        body: '早上逛老街，下午看日落。',
        tags: ['#北海旅游', '#周末去哪儿'],
        textRevisionId: 9,
        reviewStatus: 'APPROVED',
        imageCount: 3,
        exportedAt: '2026-08-25T02:03:04.000Z',
        images: [
          { pageIndex: 1, fileName: 'images/01.png', assetId: 5, sha256: String(5).padStart(64, '0') },
          { pageIndex: 2, fileName: 'images/02.png', assetId: 3, sha256: String(3).padStart(64, '0') },
          { pageIndex: 3, fileName: 'images/03.png', assetId: 4, sha256: String(4).padStart(64, '0') },
        ],
      });
      assert.equal((await archive.file('images/01.png').async('nodebuffer')).toString(), 'new-page-1');
      assert.equal((await archive.file('images/02.png').async('nodebuffer')).toString(), 'page-2');
      assert.equal((await archive.file('images/03.png').async('nodebuffer')).toString(), 'page-3');
    } finally {
      await rm(assetRoot, { recursive: true, force: true });
    }
  });

  it('exports multiple approved tasks into separate folders with a batch manifest', async () => {
    const assetRoot = await mkdtemp(join(tmpdir(), 'xhs-task-batch-export-'));
    try {
      for (const taskId of [42, 43]) {
        await mkdir(join(assetRoot, String(taskId)), { recursive: true });
        await Promise.all([1, 2, 3].map((pageIndex) => writeFile(
          join(assetRoot, String(taskId), `page-${pageIndex}.png`),
          Buffer.from(`${taskId}-page-${pageIndex}`),
        )));
      }
      const tasks = [42, 43].map((taskId) => approvedTask({
        id: taskId,
        query: `批量选题 ${taskId}`,
        config: { externalId: `xhs-${taskId}` },
        assets: [1, 2, 3].map((pageIndex) => deliveryAsset({
          id: taskId * 10 + pageIndex,
          pageIndex,
          relativePath: `${taskId}/page-${pageIndex}.png`,
        })),
      }));

      const result = await buildTaskBatchExportArchive({
        tasks,
        assetRoot,
        exportedAt: new Date('2026-08-25T02:03:04.000Z'),
      });
      const archive = await JSZip.loadAsync(result.buffer);

      assert.equal(result.fileName, 'xhs-task-batch-20260825T020304Z.zip');
      assert.deepEqual(JSON.parse(await archive.file('manifest.json').async('string')), {
        exportedAt: '2026-08-25T02:03:04.000Z',
        taskCount: 2,
        tasks: [
          { taskId: 42, externalId: 'xhs-42', query: '批量选题 42', folder: 'tasks/task-42/' },
          { taskId: 43, externalId: 'xhs-43', query: '批量选题 43', folder: 'tasks/task-43/' },
        ],
      });
      assert.equal(await archive.file('tasks/task-43/images/03.png').async('string'), '43-page-3');
      assert.match(await archive.file('tasks/task-42/content.txt').async('string'), /北海一日游路线/);
      assert.equal(JSON.parse(await archive.file('tasks/task-43/metadata.json').async('string')).taskId, 43);
    } finally {
      await rm(assetRoot, { recursive: true, force: true });
    }
  });

  it('rejects oversized or duplicate batch selections before reading task assets', async () => {
    await assert.rejects(
      () => buildTaskBatchExportArchive({
        tasks: Array.from({ length: MAX_BATCH_EXPORT_TASKS + 1 }, (_, index) => ({ id: index + 1 })),
        assetRoot: tmpdir(),
      }),
      /最多.*任务/,
    );
    await assert.rejects(
      () => buildTaskBatchExportArchive({
        tasks: [{ id: 42 }, { id: 42 }],
        assetRoot: tmpdir(),
      }),
      /不能重复/,
    );
  });

  it('rejects a batch when its delivery files exceed the configured byte budget', async () => {
    const assetRoot = await mkdtemp(join(tmpdir(), 'xhs-task-batch-budget-'));
    try {
      await mkdir(join(assetRoot, '42'), { recursive: true });
      await Promise.all([1, 2, 3].map((pageIndex) => writeFile(
        join(assetRoot, '42', `page-${pageIndex}.png`),
        Buffer.from(`page-${pageIndex}`),
      )));
      const task = approvedTask({
        assets: [1, 2, 3].map((pageIndex) => deliveryAsset({
          id: pageIndex,
          pageIndex,
          relativePath: `42/page-${pageIndex}.png`,
        })),
      });

      await assert.rejects(
        () => buildTaskBatchExportArchive({ tasks: [task], assetRoot, maxBytes: 10 }),
        /批量导出文件过大/,
      );
    } finally {
      await rm(assetRoot, { recursive: true, force: true });
    }
  });

  it('exports a waiting-review task with a complete current image set', async () => {
    const assetRoot = await mkdtemp(join(tmpdir(), 'xhs-task-waiting-export-'));
    try {
      await mkdir(join(assetRoot, '42'), { recursive: true });
      await Promise.all([1, 2, 3].map((pageIndex) => writeFile(
        join(assetRoot, '42', `page-${pageIndex}.png`),
        Buffer.from(`waiting-page-${pageIndex}`),
      )));
      const task = approvedTask({
        config: { reviewStatus: 'WAITING_REVIEW' },
        assets: [1, 2, 3].map((pageIndex) => deliveryAsset({
          id: pageIndex,
          pageIndex,
          relativePath: `42/page-${pageIndex}.png`,
          alignmentStatus: pageIndex === 2 ? 'MANUAL_REQUIRED' : 'PASSED',
        })),
      });

      assert.deepEqual(getTaskExportAvailability(task), { canExport: true, reason: null });
      const result = await buildTaskExportArchive({ task, assetRoot });
      const archive = await JSZip.loadAsync(result.buffer);
      assert.equal(JSON.parse(await archive.file('metadata.json').async('string')).reviewStatus, 'WAITING_REVIEW');
      assert.equal(await archive.file('images/02.png').async('string'), 'waiting-page-2');
    } finally {
      await rm(assetRoot, { recursive: true, force: true });
    }
  });

  it('uses paginated task export-readiness summaries without loading full task details', () => {
    const task = approvedTask({
      config: { reviewStatus: 'WAITING_REVIEW' },
      assets: undefined,
    });
    delete task.assets;
    task.exportReadiness = { assetCount: 3, alignedAssetCount: 2 };

    assert.deepEqual(getTaskExportAvailability(task), { canExport: true, reason: null });
  });

  it('explains why tasks outside review or without complete current images cannot export', async () => {
    const notReady = approvedTask({ config: { reviewStatus: 'NOT_READY' } });
    assert.deepEqual(getTaskExportAvailability(notReady), {
      canExport: false,
      reason: '任务生成完成并进入待审核后才能导出',
    });
    await assert.rejects(
      () => buildTaskExportArchive({ task: notReady, assetRoot: tmpdir() }),
      /进入待审核/,
    );

    const rejected = approvedTask({ config: { reviewStatus: 'REJECTED' } });
    assert.deepEqual(getTaskExportAvailability(rejected), {
      canExport: false,
      reason: '任务已驳回，请重新打开审核后再导出',
    });

    await assert.rejects(
      () => buildTaskExportArchive({
        task: approvedTask({ assets: [
          deliveryAsset({ id: 1, pageIndex: 1, relativePath: '42/page-1.png' }),
        ] }),
        assetRoot: tmpdir(),
      }),
      /完整.*图片/,
    );
  });

  it('rejects a delivery count outside the supported three-to-five image range', async () => {
    const assets = [1, 2].map((pageIndex) => deliveryAsset({
      id: pageIndex,
      pageIndex,
      relativePath: `42/page-${pageIndex}.png`,
    }));

    await assert.rejects(
      () => buildTaskExportArchive({
        task: approvedTask({ config: { imageCount: 2 }, assets }),
        assetRoot: tmpdir(),
      }),
      /图片数量无效/,
    );
  });

  it('rejects image paths that escape the configured asset root', async () => {
    const assets = [1, 2, 3].map((pageIndex) => deliveryAsset({
      id: pageIndex,
      pageIndex,
      relativePath: '../outside.png',
    }));

    await assert.rejects(
      () => buildTaskExportArchive({ task: approvedTask({ assets }), assetRoot: tmpdir() }),
      /图片路径/,
    );
  });
});
