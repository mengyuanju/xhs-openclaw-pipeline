import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import JSZip from 'jszip';
import { inspectDeliverySources, writeDeliveryAggregate } from '../src/delivery-archives.mjs';
import { buildBatchTaskArchive } from '../src/task-archive.mjs';

async function storage(t) {
  const root = await mkdtemp(join(tmpdir(), 'xhs-delivery-archive-test-'));
  t.after(async () => {
    assert.ok(root.startsWith(join(tmpdir(), 'xhs-delivery-archive-test-')));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await mkdir(join(root, '.delivery-batches'));
  return root;
}

async function saveSource(root, bytes, taskIds = [1]) {
  const publicId = randomUUID();
  await writeFile(join(root, '.delivery-batches', `${publicId}.zip`), bytes);
  return taskIds.map(taskId => ({
    item_id: taskId, task_id: taskId, copy_revision_id: taskId + 10, image_run_id: randomUUID(),
    batch_public_id: publicId, batch_code: 'JF-TEST', source_byte_size: bytes.length,
    source_sha256: createHash('sha256').update(bytes).digest('hex'), query: `Query ${taskId}`,
  }));
}

function job() {
  return { id: 1, run_token: randomUUID(), kind: 'DOWNLOAD', actor_role: 'ADMIN', actor_account_id: 1, actor_username: 'admin' };
}

function memberDirectory(row) {
  return `${row.task_id}/${row.copy_revision_id}/${row.image_run_id}`;
}

test('aggregate extracts selected task files from new batch folders with unchanged bytes', async t => {
  const root = await storage(t);
  const tasks = [1, 2].map(id => ({
    id, query: `Query ${id}`, currentCopyRevisionId: id + 10, currentImageRunId: `run-${id}`,
    copyRevisions: [{ id: id + 10, content: { copy: { title: '相同标题', body: `正文${id}` } } }],
    imageRuns: [{ id: `run-${id}`, result: { images: [{ assetId: id }] } }],
    assets: [{ id, imageRunId: `run-${id}`, mediaType: 'image/png' }],
    xiaohongshuSearchStatus: 'SUCCEEDED',
  }));
  const source = await buildBatchTaskArchive(tasks, async task => ({
    mediaType: 'image/png', originalName: '封面.png', content: Buffer.from([0, 1, 255, task.id]),
  }));
  const rows = await saveSource(root, source, [1, 2]);
  const { members, totalBytes } = await inspectDeliverySources(root, [rows[0]]);
  assert.equal(members.length, 1);
  const original = await JSZip.loadAsync(source);
  const files = Object.values(original.files).filter(file => file.name.startsWith('未归属甲方批次/任务-1-资源包/'));
  let expectedBytes = 0;
  for (const file of files) expectedBytes += (await file.async('nodebuffer')).length;
  assert.equal(totalBytes, expectedBytes);
  const artifacts = await writeDeliveryAggregate(root, job(), members);
  const result = await JSZip.loadAsync(await readFile(join(root, '.delivery-archives', '1', artifacts[0].file)));
  assert.equal(Object.keys(result.files).some(name => name.endsWith('.zip')), false);
  assert.equal(Object.keys(result.files).some(name => name.startsWith('2/')), false);
  assert.ok(result.file('清单.xlsx'));
  assert.equal(JSON.parse(await result.file('manifest.json').async('string')).items.length, 1);
  for (const file of files) {
    assert.deepEqual(await result.file(`${memberDirectory(rows[0])}/${file.name.split('/').at(-1)}`).async('nodebuffer'),
      await file.async('nodebuffer'));
  }
});

test('aggregate flattens legacy task ZIPs and keeps versions separate across batches', async t => {
  const root = await storage(t);
  const rows = [];
  for (const version of [1, 2]) {
    const inner = new JSZip();
    inner.file('文案.txt', `冻结正文${version}`);
    inner.file('01-图片.png', Buffer.from([0, 255, version]));
    const outer = new JSZip();
    outer.file('旧词包/任务-1-资源包.zip', await inner.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    outer.file('旧词包/任务-2-资源包.zip', Buffer.from('unselected member must not be read'));
    const [row] = await saveSource(root, await outer.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    rows.push({ ...row, item_id: version, copy_revision_id: version + 10 });
  }
  const { members, totalBytes } = await inspectDeliverySources(root, rows);
  assert.equal(totalBytes, Buffer.byteLength('冻结正文1冻结正文2') + 6);
  const artifacts = await writeDeliveryAggregate(root, job(), members);
  const result = await JSZip.loadAsync(await readFile(join(root, '.delivery-archives', '1', artifacts[0].file)));
  assert.equal(Object.keys(result.files).some(name => name.endsWith('.zip')), false);
  for (const [index, row] of rows.entries()) {
    assert.equal(await result.file(`${memberDirectory(row)}/文案.txt`).async('string'), `冻结正文${index + 1}`);
    assert.deepEqual(await result.file(`${memberDirectory(row)}/01-图片.png`).async('nodebuffer'), Buffer.from([0, 255, index + 1]));
  }
});

test('source inspection rejects ambiguous task folders and mixed legacy and new members', async t => {
  const root = await storage(t);
  for (const extraName of ['其他批次/任务-1-资源包/文案.txt', '批次/任务-1-资源包.zip', '批次/任务-1-资源包/COPY.TXT']) {
    const zip = new JSZip();
    zip.file('批次/任务-1-资源包/copy.txt', 'frozen');
    zip.file(extraName, 'duplicate');
    const rows = await saveSource(root, await zip.generateAsync({ type: 'nodebuffer' }));
    await assert.rejects(inspectDeliverySources(root, rows), { code: 'DELIVERY_SOURCE_AMBIGUOUS' });
  }
});

test('source inspection rejects missing tasks, changed source bytes and unsafe legacy file paths', async t => {
  const root = await storage(t);
  const zip = new JSZip();
  zip.file('批次/任务-1-资源包/文案.txt', 'frozen');
  const rows = await saveSource(root, await zip.generateAsync({ type: 'nodebuffer' }), [1, 2]);
  await assert.rejects(inspectDeliverySources(root, rows), { code: 'DELIVERY_SOURCE_MISSING' });
  await assert.rejects(inspectDeliverySources(root, [{ ...rows[0], source_sha256: '0'.repeat(64) }]), { code: 'DELIVERY_SOURCE_MISSING' });
  const inner = new JSZip();
  inner.file('../outside.txt', 'unsafe');
  const legacy = new JSZip();
  legacy.file('批次/任务-1-资源包.zip', await inner.generateAsync({ type: 'nodebuffer' }));
  const unsafeRows = await saveSource(root, await legacy.generateAsync({ type: 'nodebuffer' }));
  await assert.rejects(inspectDeliverySources(root, unsafeRows), /invalid relative path/u);
});

test('aggregate removes partial output when a frozen file disappears after inspection', async t => {
  const root = await storage(t);
  const zip = new JSZip();
  zip.file('批次/任务-1-资源包/文案.txt', 'frozen');
  zip.file('批次/任务-1-资源包/01.png', Buffer.from([1, 2, 3]));
  const rows = await saveSource(root, await zip.generateAsync({ type: 'nodebuffer' }));
  const { members } = await inspectDeliverySources(root, rows);
  zip.remove('批次/任务-1-资源包/01.png');
  await writeFile(members[0].path, await zip.generateAsync({ type: 'nodebuffer' }));
  await assert.rejects(writeDeliveryAggregate(root, job(), members), /冻结成员丢失/u);
  assert.deepEqual(await readdir(join(root, '.delivery-archives', '1')), []);
});
