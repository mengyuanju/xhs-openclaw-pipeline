import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import JSZip from 'jszip';
import sharp from 'sharp';
import { createDeliverySnapshot, saveDeliverySnapshot } from '../src/delivery-snapshots.mjs';
import { findSmallHistoricalBatch, verifyHistoricalDeliverySnapshot } from '../../scripts/verify-historical-delivery.mjs';

async function storage(t) {
  const temporary = await mkdtemp(join(tmpdir(), 'xhs-history-verification-')), root = await realpath(temporary);
  t.after(async () => {
    assert.ok(temporary.startsWith(join(tmpdir(), 'xhs-history-verification-')));
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return root;
}

async function batch(root, { legacy = false, taskIds = [1], textPadding = '' } = {}) {
  const publicId = randomUUID(), image = await sharp({ create: { width: 3, height: 4, channels: 4, background: { r: 120, g: 50, b: 10, alpha: 1 } } }).png().toBuffer();
  const outer = new JSZip();
  for (const taskId of taskIds) {
    await mkdir(join(root, 'tasks', String(taskId)), { recursive: true });
    await writeFile(join(root, 'tasks', String(taskId), 'original.png'), image);
    const text = legacy
      ? `\uFEFF标题：历史标题${taskId}\r\n\r\n文案内容：\r\n历史正文${taskId}${textPadding}\r\n\r\n标签：#历史 #测试\r\n`
      : `\uFEFF原始 Query：冻结问题${taskId}\r\n\r\n标题：历史标题${taskId}\r\n\r\n文案内容：\r\n历史正文${taskId}${textPadding}\r\n`;
    const links = `\uFEFFQuery：冻结问题${taskId}\r\n搜索状态：搜索完成\r\n\r\n小红书链接：\r\n1. 历史链接\r\nhttps://example.com/historical/${taskId}\r\n`;
    const directory = `历史批次/任务-${taskId}-资源包`;
    if (legacy) {
      const inner = new JSZip(); inner.file('文案.txt', text); inner.file('小红书链接.txt', links); inner.file('01.png', image);
      outer.file(`${directory}.zip`, await inner.generateAsync({ type: 'nodebuffer' }));
    } else {
      outer.file(`${directory}/文案.txt`, text); outer.file(`${directory}/小红书链接.txt`, links); outer.file(`${directory}/01.png`, image);
    }
  }
  const source = join(root, `source-${publicId}.zip`);
  await writeFile(source, await outer.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  const snapshot = await createDeliverySnapshot(root, source, publicId, { resolveImage: async ({ taskId }) => ({ storagePath: `tasks/${taskId}/original.png` }) });
  await saveDeliverySnapshot(root, snapshot);
  await rm(source);
  return { publicId, snapshot, image };
}

async function assertNoExports(root) {
  assert.deepEqual(await readdir(join(root, '.delivery-exports')).catch(error => { if (error.code === 'ENOENT') return []; throw error; }), []);
}

test('a real historical snapshot rebuilds exact ZIP members and a workbook with original image bytes, then removes all artifacts', async t => {
  const root = await storage(t), item = await batch(root, { taskIds: [1, 2] });
  const before = await readFile(join(root, '.delivery-snapshots', `${item.publicId}.json`));
  const report = await verifyHistoricalDeliverySnapshot(root, item.publicId);
  assert.equal(report.verified, true);
  assert.equal(report.taskCount, 2);
  assert.equal(report.fileCount, 6);
  assert.equal(report.archive.verified, true);
  assert.equal(report.archive.memberCount, 6);
  assert.equal(report.spreadsheet.verified, true);
  assert.equal(report.spreadsheet.embeddedImageCount, 2);
  assert.equal(report.spreadsheet.emptyFrozenQueryCount, 0);
  assert.equal(report.temporaryCleaned, true);
  assert.doesNotMatch(JSON.stringify(report), /历史正文|冻结问题|example\.com/u, 'reports contain no business text or URLs');
  assert.deepEqual(await readFile(join(root, '.delivery-snapshots', `${item.publicId}.json`)), before);
  assert.deepEqual(await readFile(join(root, 'tasks', '1', 'original.png')), item.image);
  await assertNoExports(root);
});

test('legacy nested archives without Query headers retain restore and Excel compatibility', async t => {
  const root = await storage(t), item = await batch(root, { legacy: true });
  const report = await verifyHistoricalDeliverySnapshot(root, item.publicId, { bindings: [{ taskId: 1, query: '数据库冻结问题', copyRevisionId: 7, imageRunId: randomUUID() }] });
  assert.equal(report.archive.verified, true);
  assert.equal(report.spreadsheet.verified, true);
  assert.equal(report.spreadsheet.bindingsProvided, 1);
  assert.equal(report.spreadsheet.emptyFrozenQueryCount, 0);
  assert.equal(report.temporaryCleaned, true);
  await assertNoExports(root);
});

test('small-batch selection reads snapshot metadata and chooses the smallest eligible original', async t => {
  const root = await storage(t);
  const large = await batch(root, { taskIds: [2], textPadding: 'larger historical content'.repeat(100) });
  const small = await batch(root);
  const selected = await findSmallHistoricalBatch(root);
  assert.equal(selected.publicId, small.publicId);
  assert.notEqual(selected.publicId, large.publicId);
  const report = await verifyHistoricalDeliverySnapshot(root);
  assert.equal(report.publicId, small.publicId);
  assert.equal(report.verified, true);
  await assertNoExports(root);
});

test('missing or changed original images fail verification without leaving a ZIP or workbook', async t => {
  for (const mutation of ['missing', 'changed']) await t.test(mutation, async child => {
    const root = await storage(child), item = await batch(root), path = join(root, 'tasks', '1', 'original.png');
    if (mutation === 'missing') await rm(path);
    else await writeFile(path, Buffer.alloc(item.image.length, 15));
    await assert.rejects(verifyHistoricalDeliverySnapshot(root, item.publicId), { code: 'DELIVERY_SOURCE_MISSING' });
    await assertNoExports(root);
  });
});

test('a failed spreadsheet reconstruction cleans the already-verified ZIP and all spreadsheet artifacts', async t => {
  const root = await storage(t), item = await batch(root);
  const original = JSON.stringify(item.snapshot), damaged = structuredClone(item.snapshot);
  const copy = damaged.entries.find(file => /文案\.txt$/u.test(file.entryName));
  const { createHash } = await import('node:crypto');
  const text = Buffer.from('an unsupported legacy text layout');
  copy.contentBase64 = text.toString('base64'); copy.byteSize = text.length; copy.sha256 = createHash('sha256').update(text).digest('hex');
  damaged.members[0].byteSize = damaged.members[0].files.reduce((bytes, name) => bytes + damaged.entries.find(file => file.entryName === name).byteSize, 0);
  const { manifestSha256, ...manifest } = damaged;
  damaged.manifestSha256 = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  await writeFile(join(root, '.delivery-snapshots', `${item.publicId}.json`), JSON.stringify(damaged));
  await assert.rejects(verifyHistoricalDeliverySnapshot(root, item.publicId), { code: 'DELIVERY_SOURCE_MISSING' });
  await assertNoExports(root);
  await writeFile(join(root, '.delivery-snapshots', `${item.publicId}.json`), original);
});

test('small-check limits and pre-aborted signals fail before leaving temporary exports', async t => {
  const root = await storage(t), item = await batch(root);
  await assert.rejects(verifyHistoricalDeliverySnapshot(root, item.publicId, { maxBytes: 1 }), { code: 'HISTORICAL_BATCH_EXCEEDS_SMOKE_CHECK_BYTE_LIMIT' });
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  await assert.rejects(verifyHistoricalDeliverySnapshot(root, item.publicId, { signal: controller.signal }), /cancelled/u);
  await assertNoExports(root);
});
