import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import ExcelJS from '@excel.js/exceljs';
import JSZip from 'jszip';
import sharp from 'sharp';

import {
  MAX_DELIVERY_SPREADSHEET_IMAGE_BYTES,
  MAX_DELIVERY_SPREADSHEET_TASKS,
  writeDeliverySpreadsheet,
} from '../src/delivery-spreadsheet.mjs';

async function withSpreadsheet(action) {
  const directory = await mkdtemp(join(tmpdir(), 'xhs-delivery-spreadsheet-'));
  const outputPath = join(directory, 'delivery.xlsx');
  try {
    return await action(outputPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function solidPng(red, green, blue) {
  return sharp({
    create: {
      width: 150,
      height: 200,
      channels: 4,
      background: { r: red, g: green, b: blue, alpha: 1 },
    },
  }).png().toBuffer();
}

function deliveryTask({
  id = 7,
  title = '标题',
  body = '正文',
  assetIds = [701],
} = {}) {
  const copyRevisionId = id * 10 + 1;
  const imageRunId = `run-${id}`;
  return {
    id,
    currentCopyRevisionId: copyRevisionId,
    currentImageRunId: imageRunId,
    copyRevisions: [{
      id: copyRevisionId,
      content: { copy: { title, body, tags: [] } },
    }],
    imageRuns: [{
      id: imageRunId,
      result: { images: assetIds.map((assetId) => ({ assetId })) },
    }],
    assets: assetIds.map((assetId) => ({
      id: assetId,
      taskId: id,
      imageRunId,
      mediaType: 'image/png',
    })),
  };
}

function embeddedImage(workbook, imageId) {
  const image = workbook.getImage(Number(imageId));
  assert.ok(image?.buffer, `missing embedded image ${imageId}`);
  return image;
}

async function assertMissing(path) {
  await assert.rejects(access(path), (error) => error?.code === 'ENOENT');
}

test('writes one plain-text article cell and embeds selected PNG/JPEG bytes unchanged in result order', async () => {
  await withSpreadsheet(async (outputPath) => {
    const task = deliveryTask({
      title: '收纳标题',
      body: '第一段\n第二段',
      assetIds: [709, 707],
    });
    task.assets = [
      task.assets[1],
      {
        id: 799,
        taskId: task.id,
        imageRunId: task.currentImageRunId,
        mediaType: 'image/png',
      },
      task.assets[0],
      {
        id: 798,
        taskId: task.id,
        imageRunId: 'old-run',
        mediaType: 'image/png',
      },
    ];

    task.assets.find((asset) => asset.id === 707).mediaType = 'image/jpeg';
    const redPng = await sharp({
      create: {
        width: 37,
        height: 53,
        channels: 4,
        background: { r: 220, g: 38, b: 38, alpha: 0.75 },
      },
    }).png({ compressionLevel: 9 }).toBuffer();
    const blueJpeg = await sharp({
      create: {
        width: 83,
        height: 41,
        channels: 3,
        background: { r: 37, g: 99, b: 235 },
      },
    }).jpeg({ quality: 73, chromaSubsampling: '4:4:4' }).toBuffer();
    const contentByAssetId = new Map([[709, redPng], [707, blueJpeg]]);
    const loadedAssetIds = [];
    const result = await writeDeliverySpreadsheet(
      [task],
      async (loadedTask, assetId) => {
        loadedAssetIds.push(assetId);
        assert.equal(loadedTask, task);
        const asset = task.assets.find((candidate) => candidate.id === assetId);
        return { ...asset, content: contentByAssetId.get(assetId) };
      },
      outputPath,
    );

    assert.deepEqual(result, { taskCount: 1, imageColumnCount: 2 });
    assert.deepEqual(loadedAssetIds, [709, 707]);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(outputPath);
    const worksheet = workbook.getWorksheet('交付内容');
    assert.ok(worksheet);
    assert.equal(worksheet.getCell('A1').value, '完整文章');
    assert.equal(worksheet.getCell('A2').value, '收纳标题\n\n第一段\n第二段');
    assert.equal(worksheet.getCell('A2').type, ExcelJS.ValueType.String);
    assert.equal(typeof worksheet.getCell('A2').value, 'string');
    assert.notEqual(worksheet.getCell('A2').font?.bold, true);
    assert.equal(worksheet.getCell('B1').value, '图片 1');
    assert.equal(worksheet.getCell('C1').value, '图片 2');

    const worksheetImages = worksheet.getImages();
    assert.equal(worksheetImages.length, 2);
    assert.equal(worksheetImages[0].range.tl.nativeCol, 1);
    assert.equal(worksheetImages[1].range.tl.nativeCol, 2);
    assert.deepEqual(worksheetImages[0].range.ext, { width: 140, height: 200 });
    assert.deepEqual(worksheetImages[1].range.ext, { width: 150, height: 74 });
    const firstImage = embeddedImage(workbook, worksheetImages[0].imageId);
    const secondImage = embeddedImage(workbook, worksheetImages[1].imageId);
    assert.equal(firstImage.extension, 'png');
    assert.equal(secondImage.extension, 'jpeg');
    assert.deepEqual(Buffer.from(firstImage.buffer), redPng);
    assert.deepEqual(Buffer.from(secondImage.buffer), blueJpeg);

    const archive = await JSZip.loadAsync(await readFile(outputPath));
    const mediaEntries = Object.values(archive.files).filter(
      (entry) => /^xl\/media\/[^/]+\.(?:png|jpeg)$/u.test(entry.name),
    );
    assert.equal(mediaEntries.length, 2);
    const pngEntry = mediaEntries.find((entry) => entry.name.endsWith('.png'));
    const jpegEntry = mediaEntries.find((entry) => entry.name.endsWith('.jpeg'));
    assert.ok(pngEntry);
    assert.ok(jpegEntry);
    assert.deepEqual(await pngEntry.async('nodebuffer'), redPng);
    assert.deepEqual(await jpegEntry.async('nodebuffer'), blueJpeg);

    const [firstMetadata, secondMetadata] = await Promise.all([
      sharp(Buffer.from(firstImage.buffer)).metadata(),
      sharp(Buffer.from(secondImage.buffer)).metadata(),
    ]);
    assert.deepEqual(
      [firstMetadata.format, firstMetadata.width, firstMetadata.height],
      ['png', 37, 53],
    );
    assert.deepEqual(
      [secondMetadata.format, secondMetadata.width, secondMetadata.height],
      ['jpeg', 83, 41],
    );
  });
});

test('embeds GIF source bytes unchanged', async () => {
  await withSpreadsheet(async (outputPath) => {
    const task = deliveryTask();
    task.assets[0].mediaType = 'image/gif';
    const content = await sharp({
      create: {
        width: 29,
        height: 43,
        channels: 4,
        background: { r: 245, g: 158, b: 11, alpha: 0.8 },
      },
    }).gif().toBuffer();

    await writeDeliverySpreadsheet(
      [task],
      async () => ({ ...task.assets[0], content }),
      outputPath,
    );

    const archive = await JSZip.loadAsync(await readFile(outputPath));
    const gifEntries = Object.values(archive.files).filter(
      (entry) => /^xl\/media\/[^/]+\.gif$/u.test(entry.name),
    );
    assert.equal(gifEntries.length, 1);
    assert.deepEqual(await gifEntries[0].async('nodebuffer'), content);
  });
});

test('rejects unsupported source image formats instead of transcoding them', async () => {
  await withSpreadsheet(async (outputPath) => {
    const task = deliveryTask();
    task.assets[0].mediaType = 'image/webp';
    const content = await sharp({
      create: {
        width: 30,
        height: 20,
        channels: 3,
        background: { r: 37, g: 99, b: 235 },
      },
    }).webp().toBuffer();

    await assert.rejects(
      writeDeliverySpreadsheet(
        [task],
        async () => ({ ...task.assets[0], content }),
        outputPath,
      ),
      (error) => error instanceof TypeError && /仅支持 PNG、JPEG 或 GIF/u.test(error.message),
    );
    await assertMissing(outputPath);
  });
});

test('keeps dangerous formula prefixes as text and emits no worksheet formula nodes', async () => {
  await withSpreadsheet(async (outputPath) => {
    const title = '=HYPERLINK("https://example.invalid","点我")';
    const body = '+1\n-2\n@SUM(A1:A2)\n\t=cmd()';
    const task = deliveryTask({ title, body });
    const content = await solidPng(128, 128, 128);

    await writeDeliverySpreadsheet(
      [task],
      async (_loadedTask, assetId) => ({
        ...task.assets.find((asset) => asset.id === assetId),
        content,
      }),
      outputPath,
    );

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(outputPath);
    const articleCell = workbook.getWorksheet('交付内容').getCell('A2');
    assert.equal(articleCell.value, `${title}\n\n${body}`);
    assert.equal(articleCell.type, ExcelJS.ValueType.String);
    assert.equal(articleCell.formula, undefined);

    const archive = await JSZip.loadAsync(await readFile(outputPath));
    const worksheetEntries = Object.values(archive.files).filter(
      (entry) => /^xl\/worksheets\/sheet\d+\.xml$/u.test(entry.name),
    );
    assert.ok(worksheetEntries.length > 0);
    for (const entry of worksheetEntries) {
      assert.doesNotMatch(await entry.async('string'), /<f(?:\s|>)/u);
    }
  });
});

test('enforces the task limit before loading an over-limit task', async () => {
  assert.equal(MAX_DELIVERY_SPREADSHEET_TASKS, 200);
  await withSpreadsheet(async (outputPath) => {
    const tasks = [
      deliveryTask({ id: 1, assetIds: [101] }),
      deliveryTask({ id: 2, assetIds: [201] }),
    ];
    const content = await solidPng(128, 128, 128);
    const loadedTaskIds = [];

    await assert.rejects(
      writeDeliverySpreadsheet(
        tasks,
        async (task, assetId) => {
          loadedTaskIds.push(task.id);
          return {
            ...task.assets.find((asset) => asset.id === assetId),
            content,
          };
        },
        outputPath,
        { maxTasks: 1 },
      ),
      (error) => error instanceof RangeError && /一次最多 1 篇文章/u.test(error.message),
    );
    assert.deepEqual(loadedTaskIds, [1]);
    await assertMissing(outputPath);
  });
});

test('enforces the cumulative original-image byte limit', async () => {
  assert.equal(MAX_DELIVERY_SPREADSHEET_IMAGE_BYTES, 256 * 1024 * 1024);
  await withSpreadsheet(async (outputPath) => {
    const task = deliveryTask({ assetIds: [701, 702] });
    task.assets[1].mediaType = 'image/jpeg';
    const firstContent = await solidPng(220, 38, 38);
    const secondContent = await sharp({
      create: {
        width: 150,
        height: 200,
        channels: 3,
        background: { r: 37, g: 99, b: 235 },
      },
    }).jpeg({ quality: 73 }).toBuffer();
    const contentByAssetId = new Map([
      [701, firstContent],
      [702, secondContent],
    ]);
    const maxImageBytes = Math.max(firstContent.byteLength, secondContent.byteLength);
    assert.ok(firstContent.byteLength <= maxImageBytes);
    assert.ok(secondContent.byteLength <= maxImageBytes);
    assert.ok(firstContent.byteLength + secondContent.byteLength > maxImageBytes);
    const loadedAssetIds = [];

    await assert.rejects(
      writeDeliverySpreadsheet(
        [task],
        async (_loadedTask, assetId) => {
          loadedAssetIds.push(assetId);
          return {
            ...task.assets.find((asset) => asset.id === assetId),
            content: contentByAssetId.get(assetId),
          };
        },
        outputPath,
        { maxImageBytes },
      ),
      (error) => error instanceof RangeError && /原图总大小超出/u.test(error.message),
    );
    assert.deepEqual(loadedAssetIds, [701, 702]);
    await assertMissing(outputPath);
  });
});

test('does not leave a workbook or temporary file when cancelled after serialization', async () => {
  await withSpreadsheet(async (outputPath) => {
    const task = deliveryTask();
    const content = await solidPng(128, 128, 128);
    const signal = {
      throwIfAborted() {
        const temporaryWorkbookExists = readdirSync(dirname(outputPath))
          .some((name) => name.startsWith('delivery.xlsx.') && name.endsWith('.tmp'));
        if (temporaryWorkbookExists) {
          throw new DOMException('cancelled after serialization', 'AbortError');
        }
      },
    };

    await assert.rejects(
      writeDeliverySpreadsheet(
        [task],
        async () => ({ ...task.assets[0], content }),
        outputPath,
        { signal },
      ),
      (error) => error?.name === 'AbortError',
    );
    await assertMissing(outputPath);
    assert.deepEqual(readdirSync(dirname(outputPath)), []);
  });
});

test('rejects missing, mismatched, non-image, and invalid-content assets', async (t) => {
  const validContent = await solidPng(128, 128, 128);
  const cases = [
    {
      name: 'missing loader result',
      change: () => null,
      expected: /交付图片缺失/u,
    },
    {
      name: 'wrong asset identity',
      change: (asset) => ({ ...asset, id: asset.id + 1, content: validContent }),
      expected: /交付图片缺失/u,
    },
    {
      name: 'wrong task binding',
      change: (asset) => ({ ...asset, taskId: asset.taskId + 1, content: validContent }),
      expected: /交付图片缺失/u,
    },
    {
      name: 'wrong image-run binding',
      change: (asset) => ({ ...asset, imageRunId: 'wrong-run', content: validContent }),
      expected: /交付图片缺失/u,
    },
    {
      name: 'non-image media type',
      change: (asset) => ({ ...asset, mediaType: 'text/plain', content: validContent }),
      expected: /交付图片缺失/u,
    },
    {
      name: 'unsupported image media type',
      change: (asset) => ({ ...asset, mediaType: 'image/svg+xml', content: validContent }),
      expected: /交付图片缺失/u,
    },
    {
      name: 'invalid image bytes container',
      change: (asset) => ({ ...asset, content: 'not-a-buffer' }),
      expected: /交付图片内容无效/u,
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      await withSpreadsheet(async (outputPath) => {
        const task = deliveryTask();
        await assert.rejects(
          writeDeliverySpreadsheet(
            [task],
            async (_loadedTask, assetId) => testCase.change(
              task.assets.find((asset) => asset.id === assetId),
            ),
            outputPath,
          ),
          testCase.expected,
        );
        await assertMissing(outputPath);
      });
    });
  }

  await t.test('snapshot does not contain the selected asset', async () => {
    await withSpreadsheet(async (outputPath) => {
      const task = deliveryTask();
      task.assets = [];
      let loaderCalls = 0;
      await assert.rejects(
        writeDeliverySpreadsheet(
          [task],
          async () => { loaderCalls += 1; },
          outputPath,
        ),
        /交付图片资产缺失/u,
      );
      assert.equal(loaderCalls, 0);
      await assertMissing(outputPath);
    });
  });
});

test('rejects duplicate or excessive image bindings before loading assets', async (t) => {
  for (const [name, assetIds] of [
    ['duplicate bindings', [701, 701]],
    ['more than five images', [701, 702, 703, 704, 705, 706]],
  ]) {
    await t.test(name, async () => {
      await withSpreadsheet(async (outputPath) => {
        const task = deliveryTask({ assetIds });
        let loaderCalls = 0;
        await assert.rejects(
          writeDeliverySpreadsheet(
            [task],
            async () => { loaderCalls += 1; },
            outputPath,
          ),
          /交付图片资产绑定无效/u,
        );
        assert.equal(loaderCalls, 0);
        await assertMissing(outputPath);
      });
    });
  }
});
