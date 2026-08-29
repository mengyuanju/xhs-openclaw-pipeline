import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { createAdminStore } from '../src/admin/admin-store.mjs';
import {
  materializeFile,
  optimizeAllTaskStorage,
  optimizeTaskStorage,
} from '../src/admin/storage-optimizer.mjs';

const directories = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe('storage optimizer file materialization', () => {
  it('uses a hard link when source and destination share a filesystem', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xhs-storage-link-'));
    directories.push(directory);
    const source = join(directory, 'source.png');
    const destination = join(directory, 'assets', 'destination.png');
    await writeFile(source, Buffer.from('same physical image'));

    const result = await materializeFile(source, destination);

    const [sourceStat, destinationStat] = await Promise.all([stat(source), stat(destination)]);
    assert.equal(result.mode, 'linked');
    assert.equal(sourceStat.dev, destinationStat.dev);
    assert.equal(sourceStat.ino, destinationStat.ino);
    assert.equal(await readFile(destination, 'utf8'), 'same physical image');
  });

  it('falls back to an exclusive copy when hard links are unavailable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xhs-storage-copy-'));
    directories.push(directory);
    const source = join(directory, 'source.png');
    const destination = join(directory, 'assets', 'destination.png');
    await writeFile(source, Buffer.from('portable image copy'));
    const unavailable = Object.assign(new Error('cross-device link'), { code: 'EXDEV' });

    const result = await materializeFile(source, destination, {
      linkFile: async () => { throw unavailable; },
    });

    assert.equal(result.mode, 'copied');
    assert.equal(await readFile(destination, 'utf8'), 'portable image copy');
  });
});

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

describe('task storage retention', () => {
  it('previews and applies cleanup without removing current delivery or edit ancestry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xhs-storage-retention-'));
    directories.push(directory);
    const outputRoot = join(directory, 'output');
    const assetRoot = join(directory, 'assets');
    const oldOutputDir = join(outputRoot, '1', 'attempt-1');
    const latestOutputDir = join(outputRoot, '1', 'attempt-2');
    const oldOutputImage = join(oldOutputDir, 'old.png');
    const editedParentOutputImage = join(oldOutputDir, 'edited-parent.png');
    const latestOutputImage = join(latestOutputDir, 'current.png');
    const currentAssetName = '11111111-1111-4111-8111-111111111111-current.png';
    const oldAssetPath = 'generated/1/attempt-1/22222222-2222-4222-8222-222222222222-old.png';
    const currentAssetPath = `generated/1/attempt-2/${currentAssetName}`;
    const editedParentPath = 'generated/1/attempt-1/33333333-3333-4333-8333-333333333333-edited-parent.png';
    const editedAssetPath = 'revisions/1/revision-edited.png';
    const oldContent = Buffer.from('obsolete generated image');
    const currentContent = Buffer.from('current generated image');
    const parentContent = Buffer.from('edited image parent');
    const editedContent = Buffer.from('edited current image');
    await Promise.all([
      mkdir(oldOutputDir, { recursive: true }),
      mkdir(latestOutputDir, { recursive: true }),
      mkdir(join(assetRoot, 'generated', '1', 'attempt-1'), { recursive: true }),
      mkdir(join(assetRoot, 'generated', '1', 'attempt-2'), { recursive: true }),
      mkdir(join(assetRoot, 'revisions', '1'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(oldOutputImage, oldContent),
      writeFile(editedParentOutputImage, parentContent),
      writeFile(join(oldOutputDir, 'post.json'), '{"attempt":1}'),
      writeFile(join(outputRoot, '1', 'checkpoint.json'), JSON.stringify({
        images: [{ relativePath: '1/attempt-1/edited-parent.png' }],
      })),
      writeFile(latestOutputImage, currentContent),
      writeFile(join(latestOutputDir, 'post.json'), '{"attempt":2}'),
      writeFile(join(assetRoot, oldAssetPath), oldContent),
      writeFile(join(assetRoot, currentAssetPath), currentContent),
      writeFile(join(assetRoot, editedParentPath), parentContent),
      writeFile(join(assetRoot, editedAssetPath), editedContent),
    ]);

    const task = {
      id: 1,
      config: { currentTextRevisionId: 2, imageCount: 2 },
      assets: [
        {
          id: 1, kind: 'GENERATED', parentAssetId: null, sourceTextRevisionId: 1,
          pageIndex: 1, relativePath: oldAssetPath,
          fileName: '22222222-2222-4222-8222-222222222222-old.png', sha256: sha256(oldContent),
        },
        {
          id: 2, kind: 'GENERATED', parentAssetId: null, sourceTextRevisionId: 2,
          pageIndex: 1, relativePath: currentAssetPath,
          fileName: currentAssetName, sha256: sha256(currentContent),
        },
        {
          id: 3, kind: 'GENERATED', parentAssetId: null, sourceTextRevisionId: 1,
          pageIndex: 2, relativePath: editedParentPath,
          fileName: '33333333-3333-4333-8333-333333333333-edited-parent.png', sha256: sha256(parentContent),
        },
        {
          id: 4, kind: 'EDITED', parentAssetId: 3, sourceTextRevisionId: 1,
          pageIndex: 2, relativePath: editedAssetPath,
          fileName: 'revision-edited.png', sha256: sha256(editedContent),
        },
      ],
      generationRuns: [
        { attempt: 1, outputDir: oldOutputDir },
        { attempt: 2, outputDir: latestOutputDir },
      ],
    };
    const deletedAssetIds = [];
    const store = {
      getTask(taskId) {
        assert.equal(taskId, 1);
        return task;
      },
      deleteAssetsForRetention(taskId, assetIds) {
        assert.equal(taskId, 1);
        deletedAssetIds.push(...assetIds);
        const deleted = task.assets.filter((asset) => assetIds.includes(asset.id));
        task.assets = task.assets.filter((asset) => !assetIds.includes(asset.id));
        return deleted;
      },
    };

    const preview = await optimizeTaskStorage({
      store,
      taskId: 1,
      assetRoot,
      outputRoot,
      apply: false,
    });

    assert.equal(preview.assets.deleteCount, 1);
    assert.equal(preview.outputImages.deleteCount, 1);
    assert.equal(preview.deduplication.linkCount, 1);
    assert.deepEqual(deletedAssetIds, []);
    await access(oldOutputImage);
    await access(join(assetRoot, oldAssetPath));

    const applied = await optimizeTaskStorage({
      store,
      taskId: 1,
      assetRoot,
      outputRoot,
      apply: true,
    });

    assert.equal(applied.assets.deletedCount, 1);
    assert.equal(applied.outputImages.deletedCount, 1);
    assert.equal(applied.deduplication.linkedCount, 1);
    assert.deepEqual(deletedAssetIds, [1]);
    await assert.rejects(access(oldOutputImage), { code: 'ENOENT' });
    await access(editedParentOutputImage);
    await assert.rejects(access(join(assetRoot, oldAssetPath)), { code: 'ENOENT' });
    await access(join(assetRoot, editedParentPath));
    await access(join(assetRoot, editedAssetPath));
    await access(join(oldOutputDir, 'post.json'));
    await access(latestOutputImage);
    const [latestStat, assetStat] = await Promise.all([
      stat(latestOutputImage),
      stat(join(assetRoot, currentAssetPath)),
    ]);
    assert.equal(latestStat.dev, assetStat.dev);
    assert.equal(latestStat.ino, assetStat.ino);
  });

  it('never treats the latest output directory as historical when run rows repeat it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xhs-storage-repeated-run-'));
    directories.push(directory);
    const outputRoot = join(directory, 'output');
    const assetRoot = join(directory, 'assets');
    const latestOutputDir = join(outputRoot, '1', 'attempt-2');
    await mkdir(latestOutputDir, { recursive: true });
    await writeFile(join(latestOutputDir, 'current.png'), Buffer.from('current image'));
    const task = {
      id: 1,
      config: { currentTextRevisionId: null, imageCount: 3 },
      assets: [],
      generationRuns: [
        { attempt: 1, outputDir: latestOutputDir },
        { attempt: 2, outputDir: latestOutputDir },
      ],
    };

    const preview = await optimizeTaskStorage({
      store: { getTask: () => task },
      taskId: 1,
      assetRoot,
      outputRoot,
      apply: false,
    });

    assert.equal(preview.outputImages.deleteCount, 0);
    await access(join(latestOutputDir, 'current.png'));
  });

  it('deletes only unreferenced generated asset rows in the retention store operation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xhs-storage-store-'));
    directories.push(directory);
    const store = createAdminStore(join(directory, 'queue.db'));
    try {
      const batch = store.createImportBatch({
        name: '存储清理',
        sourceFileName: 'storage.xlsx',
        rows: [{
          rowNumber: 2,
          externalId: 'storage-1',
          query: '测试历史素材清理',
          input: {},
          imageCount: 3,
          referenceImageFiles: [],
          screening: { admitted: true, demandLevel: 'STRONG', reason: '测试', source: 'EXCEL' },
          errors: [],
        }],
      });
      store.commitImportBatch(batch.id);
      const task = store.listTasks({ pageSize: 1 }).data[0];
      const revision = store.addTextRevision(task.id, {
        title: '存储清理测试',
        body: '验证清理只能移除没有编辑子项引用的历史生成素材。',
        tags: ['#测试'],
        source: 'GENERATED',
      });
      const parent = store.addAsset({
        taskId: task.id,
        kind: 'GENERATED',
        fileName: 'parent.png',
        relativePath: 'generated/1/attempt-1/parent.png',
        mimeType: 'image/png',
        width: 1080,
        height: 1440,
        sha256: 'a'.repeat(64),
        source: 'live:test',
        sourceTextRevisionId: revision.id,
        pageIndex: 1,
      });
      store.addAsset({
        taskId: task.id,
        kind: 'EDITED',
        parentAssetId: parent.id,
        fileName: 'edited.png',
        relativePath: 'revisions/1/edited.png',
        mimeType: 'image/png',
        width: 1080,
        height: 1440,
        sha256: 'b'.repeat(64),
        source: 'manual-upload',
        sourceTextRevisionId: revision.id,
        pageIndex: 1,
      });
      const obsolete = store.addAsset({
        taskId: task.id,
        kind: 'GENERATED',
        fileName: 'obsolete.png',
        relativePath: 'generated/1/attempt-1/obsolete.png',
        mimeType: 'image/png',
        width: 1080,
        height: 1440,
        sha256: 'c'.repeat(64),
        source: 'live:test',
        sourceTextRevisionId: revision.id,
        pageIndex: 2,
      });

      assert.throws(
        () => store.deleteAssetsForRetention(task.id, [parent.id]),
        /referenced|引用/iu,
      );
      const deleted = store.deleteAssetsForRetention(task.id, [obsolete.id]);

      assert.deepEqual(deleted.map((asset) => asset.id), [obsolete.id]);
      assert.equal(store.getAsset(obsolete.id), null);
      assert.ok(store.getAsset(parent.id));
    } finally {
      store.close();
    }
  });
});

describe('database-wide storage optimization', () => {
  it('paginates through every task and aggregates a dry-run report', async () => {
    const pages = [
      { data: [{ id: 1 }, { id: 2 }], pagination: { totalPages: 2 } },
      { data: [{ id: 3 }], pagination: { totalPages: 2 } },
    ];
    const visited = [];
    const store = {
      listTasks({ page, pageSize }) {
        assert.equal(pageSize, 100);
        return pages[page - 1];
      },
    };

    const result = await optimizeAllTaskStorage({
      store,
      assetRoot: 'assets',
      outputRoot: 'output',
      apply: false,
      optimizeTask: async ({ taskId, apply }) => {
        visited.push(taskId);
        assert.equal(apply, false);
        return {
          taskId,
          assets: { deleteCount: 1, deleteBytes: 10, deletedCount: 0 },
          outputImages: { deleteCount: 2, deleteBytes: 20, deletedCount: 0 },
          deduplication: { linkCount: 1, linkBytes: 30, linkedCount: 0 },
          errors: taskId === 2 ? [{ operation: 'test', error: 'expected' }] : [],
        };
      },
    });

    assert.deepEqual(visited, [1, 2, 3]);
    assert.equal(result.taskCount, 3);
    assert.equal(result.assets.deleteCount, 3);
    assert.equal(result.outputImages.deleteCount, 6);
    assert.equal(result.deduplication.linkCount, 3);
    assert.equal(result.logicalBytes, 180);
    assert.equal(result.errors.length, 1);
  });
});
