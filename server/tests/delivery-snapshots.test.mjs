import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import JSZip from 'jszip';
import {
  buildSnapshotSpreadsheetTasks, createDeliverySnapshot, deliverySnapshotPath, inspectSnapshotSources, loadDeliverySnapshot,
  saveDeliverySnapshot, stageSnapshotBatchArchive,
} from '../src/delivery-snapshots.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');

async function fixture(t, { legacy = false, image = Buffer.from([0, 1, 255, 12]), prefix = '甲方批次/' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'xhs-snapshot-test-'));
  t.after(async () => {
    assert.ok(root.startsWith(join(tmpdir(), 'xhs-snapshot-test-')));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await mkdir(join(root, '1'));
  await writeFile(join(root, '1', 'original.png'), image);
  const content = Buffer.from('\uFEFF原始 Query：历史问题\r\n\r\n标题：历史标题\r\n\r\n文案内容：\r\n冻结文案\r\n', 'utf8');
  const task = new JSZip();
  task.file('文案.txt', content);
  task.file('01-封面.png', image);
  const zip = new JSZip(), directory = `${prefix}任务-1-资源包`;
  if (legacy) zip.file(`${directory}.zip`, await task.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  else {
    zip.file(`${directory}/文案.txt`, content);
    zip.file(`${directory}/01-封面.png`, image);
  }
  const spreadsheet = Buffer.from([80, 75, 0, 255, 0]);
  zip.file('清单.xlsx', spreadsheet);
  const archive = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const archivePath = join(root, 'source.zip'), publicId = randomUUID();
  await writeFile(archivePath, archive);
  const row = { item_id: 42, task_id: 1, batch_public_id: publicId, batch_code: 'JF-TEST', source_sha256: hash(archive), source_byte_size: archive.length, query: '当前问题', issued_query: '初始问题' };
  const resolveImage = async requested => {
    assert.equal(requested.sha256, hash(image));
    assert.equal(requested.byteSize, image.length);
    assert.equal(requested.taskId, 1);
    return { storagePath: '1/original.png' };
  };
  return { root, image, content, spreadsheet, archivePath, archive, publicId, row, directory, resolveImage };
}

test('snapshot keeps inline bytes and image references and rebuilds after deleting the original ZIP', async t => {
  const data = await fixture(t);
  const snapshot = await createDeliverySnapshot(data.root, data.archivePath, data.publicId, {
    resolveImage: data.resolveImage, expectedSha256: data.row.source_sha256, expectedByteSize: data.archive.length,
  });
  await saveDeliverySnapshot(data.root, snapshot);
  await rm(data.archivePath);
  assert.equal(snapshot.entries.find(file => file.kind === 'image').storagePath, '1/original.png');
  assert.equal(snapshot.entries.find(file => file.kind === 'image').contentBase64, undefined);
  assert.deepEqual(await loadDeliverySnapshot(data.root, data.publicId), snapshot);
  const inspected = await inspectSnapshotSources(data.root, [data.row]);
  assert.equal(inspected.members[0].row, data.row);
  assert.equal(inspected.totalBytes, data.image.length + data.content.length);
  const staged = await stageSnapshotBatchArchive(data.root, snapshot);
  assert.ok(staged.archivePath.startsWith(join(await realpath(data.root), '.delivery-exports')));
  try {
    const restored = await JSZip.loadAsync(await readFile(staged.archivePath));
    assert.deepEqual(await restored.file(`${data.directory}/文案.txt`).async('nodebuffer'), data.content);
    assert.deepEqual(await restored.file(`${data.directory}/01-封面.png`).async('nodebuffer'), data.image);
    assert.deepEqual(await restored.file('清单.xlsx').async('nodebuffer'), data.spreadsheet);
    assert.equal(restored.file('manifest.json'), null);
  } finally { await staged.cleanup(); }
  assert.deepEqual(await readdir(join(data.root, '.delivery-exports')), []);
  assert.deepEqual(await readdir(join(data.root, '.delivery-snapshots')), [`${data.publicId}.json`]);
});

test('legacy nested task archives migrate to frozen file references and clean temporary ZIPs', async t => {
  const data = await fixture(t, { legacy: true, prefix: '旧词包/' });
  const snapshot = await createDeliverySnapshot(data.root, data.archivePath, data.publicId, { resolveImage: data.resolveImage });
  assert.deepEqual(snapshot.members[0].files, [`${data.directory}/文案.txt`, `${data.directory}/01-封面.png`]);
  assert.deepEqual(await readdir(join(data.root, '.delivery-exports')), []);
  const staged = await stageSnapshotBatchArchive(data.root, snapshot);
  try {
    const restored = await JSZip.loadAsync(await readFile(staged.archivePath));
    assert.equal(restored.file(`${data.directory}.zip`), null);
    assert.deepEqual(await restored.file(`${data.directory}/01-封面.png`).async('nodebuffer'), data.image);
  } finally { await staged.cleanup(); }
});

test('source images must match archived bytes; missing or changed images fail without current-task fallback', async t => {
  const data = await fixture(t);
  await assert.rejects(createDeliverySnapshot(data.root, data.archivePath, data.publicId, { resolveImage: async () => ({ storagePath: 'missing.png' }) }), { code: 'DELIVERY_SOURCE_MISSING' });
  const snapshot = await createDeliverySnapshot(data.root, data.archivePath, data.publicId, { resolveImage: data.resolveImage });
  await saveDeliverySnapshot(data.root, snapshot);
  await writeFile(join(data.root, '1', 'original.png'), Buffer.from([9, 9, 9, 9]));
  await assert.rejects(inspectSnapshotSources(data.root, [data.row]), { code: 'DELIVERY_SOURCE_MISSING' });
  await assert.rejects(stageSnapshotBatchArchive(data.root, snapshot), { code: 'DELIVERY_SOURCE_MISSING' });
  assert.deepEqual(await readdir(join(data.root, '.delivery-exports')), []);
  await rm(join(data.root, '1', 'original.png'));
  await assert.rejects(inspectSnapshotSources(data.root, [data.row]), { code: 'DELIVERY_SOURCE_MISSING' });
});

test('snapshot publication is idempotent and rejects conflicting or tampered manifests', async t => {
  const data = await fixture(t);
  const snapshot = await createDeliverySnapshot(data.root, data.archivePath, data.publicId, { resolveImage: data.resolveImage });
  await saveDeliverySnapshot(data.root, snapshot);
  await saveDeliverySnapshot(data.root, snapshot);
  const modified = structuredClone(snapshot);
  modified.sourceArchive.sha256 = 'f'.repeat(64);
  const { manifestSha256, ...manifest } = modified;
  modified.manifestSha256 = hash(JSON.stringify(manifest));
  await assert.rejects(saveDeliverySnapshot(data.root, modified), { code: 'DELIVERY_SNAPSHOT_CONFLICT' });
  const corrupt = structuredClone(snapshot);
  corrupt.entries[0].contentBase64 = Buffer.from('changed').toString('base64');
  await writeFile(deliverySnapshotPath(data.root, data.publicId), JSON.stringify(corrupt));
  await assert.rejects(loadDeliverySnapshot(data.root, data.publicId), { code: 'DELIVERY_SOURCE_MISSING' });
  assert.deepEqual(await readdir(join(data.root, '.delivery-snapshots')), [`${data.publicId}.json`]);
});

test('unsafe local image paths, duplicate member paths and source mismatches are rejected', async t => {
  const data = await fixture(t);
  await assert.rejects(createDeliverySnapshot(data.root, data.archivePath, data.publicId, { resolveImage: async () => ({ storagePath: '../outside.png' }) }), /路径无效/u);
  await assert.rejects(createDeliverySnapshot(data.root, data.archivePath, data.publicId, { resolveImage: data.resolveImage, expectedSha256: '0'.repeat(64) }), { code: 'DELIVERY_SOURCE_MISSING' });
  const snapshot = await createDeliverySnapshot(data.root, data.archivePath, data.publicId, { resolveImage: data.resolveImage });
  await saveDeliverySnapshot(data.root, snapshot);
  await assert.rejects(inspectSnapshotSources(data.root, [{ ...data.row, source_byte_size: data.archive.length + 1 }]), { code: 'DELIVERY_SOURCE_MISSING' });
  const zip = new JSZip();
  zip.file('任务-1-资源包/Copy.txt', 'one');
  zip.file('任务-1-资源包/copy.TXT', 'two');
  await writeFile(data.archivePath, await zip.generateAsync({ type: 'nodebuffer' }));
  await assert.rejects(createDeliverySnapshot(data.root, data.archivePath, randomUUID()), { code: 'DELIVERY_SOURCE_AMBIGUOUS' });
});

test('aborted exports create no retained archive or temporary files', async t => {
  const data = await fixture(t);
  const snapshot = await createDeliverySnapshot(data.root, data.archivePath, data.publicId, { resolveImage: data.resolveImage });
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(stageSnapshotBatchArchive(data.root, snapshot, { signal: controller.signal }), /cancelled/u);
  assert.equal((await readdir(data.root)).includes('.delivery-exports'), false);
});

test('image symlinks cannot reference files outside storage', async t => {
  const data = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), 'xhs-snapshot-outside-'));
  t.after(async () => {
    assert.ok(outside.startsWith(join(tmpdir(), 'xhs-snapshot-outside-')));
    await rm(outside, { recursive: true, force: true });
  });
  await writeFile(join(outside, 'outside.png'), data.image);
  try { await symlink(outside, join(data.root, 'escape'), 'junction'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('symlinks unavailable'); return; } throw error; }
  await assert.rejects(createDeliverySnapshot(data.root, data.archivePath, data.publicId, { resolveImage: async () => ({ storagePath: 'escape/outside.png' }) }), { code: 'DELIVERY_SOURCE_MISSING' });
});

test('historical Excel tasks use snapshot copy, image order and frozen task metadata', async t => {
  const data = await fixture(t);
  const parsedSnapshot = await createDeliverySnapshot(data.root, data.archivePath, data.publicId, { resolveImage: data.resolveImage });
  const parsed = buildSnapshotSpreadsheetTasks(parsedSnapshot, [{ taskId: 1, copyRevisionId: 7, imageRunId: 'old-run', clientBatchCode: '历史批次' }])[0];
  assert.equal(parsed.query, '历史问题');
  assert.equal(parsed.copyRevisions[0].content.copy.title, '历史标题');
  assert.equal(parsed.copyRevisions[0].content.copy.body, '冻结文案');
  assert.equal(parsed.assets[0].storagePath, '1/original.png');
  assert.equal(parsed.assets[0].byteSize, data.image.length);
  assert.equal(parsed.sourceClientBatchCode, '历史批次');
  const frozenTask = { id: 1, query: '冻结Query', sourceQueryPackageName: '历史词包', currentCopyRevisionId: 3,
    currentImageRunId: 'old', copyRevisions: [{ id: 3, content: { copy: { title: '原始标题', body: '原始正文' } } }],
    xiaohongshuLinks: [{ url: 'https://example.com/old', rank: 1 }], xiaohongshuSearchStatus: 'SUCCEEDED',
    privateCredential: 'must never persist' };
  const snapshot = await createDeliverySnapshot(data.root, data.archivePath, data.publicId, { resolveImage: data.resolveImage, taskSnapshots: [frozenTask] });
  frozenTask.copyRevisions[0].content.copy.body = 'mutated live copy';
  assert.equal(snapshot.taskSnapshots[0].privateCredential, undefined);
  const task = buildSnapshotSpreadsheetTasks(snapshot)[0];
  assert.equal(task.copyRevisions[0].content.copy.body, '原始正文');
  assert.equal(task.query, '冻结Query');
  assert.equal(task.xiaohongshuLinks[0].url, 'https://example.com/old');
  assert.equal(task.sourceQueryPackageName, '历史词包');
  assert.equal(task.assets[0].snapshotFile.sha256, hash(data.image));
});

test('cancelling an active export removes the partial ZIP directory', async t => {
  const data = await fixture(t, { image: Buffer.alloc(8 * 1024 ** 2, 61) });
  const snapshot = await createDeliverySnapshot(data.root, data.archivePath, data.publicId, { resolveImage: data.resolveImage });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('midcancel')), 15);
  try { await assert.rejects(stageSnapshotBatchArchive(data.root, snapshot, { signal: controller.signal }), /midcancel|abort/iu); }
  finally { clearTimeout(timer); }
  assert.deepEqual(await readdir(join(data.root, '.delivery-exports')), []);
});

test('legacy copy without a Query header separates trailing tags and preserves original TXT bytes when rebuilt', async t => {
  const data = await fixture(t, { legacy: true });
  const legacyText = Buffer.from('\uFEFF标题：旧版标题\r\n\r\n文案内容：\r\n旧版正文\r\n第二段\r\n\r\n标签：#历史标签 #交付内容\r\n');
  const linksText = Buffer.from('\uFEFFQuery：链接文件冻结问题\r\n搜索状态：搜索完成\r\n\r\n小红书链接：\r\n1. 历史链接\r\nhttps://example.com/historical\r\n');
  const inner = new JSZip();
  inner.file('旧版标题.txt', legacyText);
  inner.file('小红书链接.txt', linksText);
  inner.file('01.png', data.image);
  const outer = new JSZip();
  outer.file(`${data.directory}.zip`, await inner.generateAsync({ type: 'nodebuffer' }));
  await writeFile(data.archivePath, await outer.generateAsync({ type: 'nodebuffer' }));
  const snapshot = await createDeliverySnapshot(data.root, data.archivePath, data.publicId, { resolveImage: data.resolveImage });
  const [task] = buildSnapshotSpreadsheetTasks(snapshot, [{ taskId: 1, query: '数据库冻结问题', copyRevisionId: 17, imageRunId: 'legacy-run' }]);
  assert.equal(task.query, '数据库冻结问题');
  assert.deepEqual(task.copyRevisions[0].content.copy, { title: '旧版标题', body: '旧版正文\r\n第二段', tags: ['#历史标签', '#交付内容'] });
  assert.equal(task.xiaohongshuLinks[0].url, 'https://example.com/historical');
  assert.equal(buildSnapshotSpreadsheetTasks(snapshot)[0].query, '链接文件冻结问题');
  const staged = await stageSnapshotBatchArchive(data.root, snapshot);
  try {
    const restored = await JSZip.loadAsync(await readFile(staged.archivePath));
    assert.deepEqual(await restored.file(`${data.directory}/旧版标题.txt`).async('nodebuffer'), legacyText);
    assert.deepEqual(await restored.file(`${data.directory}/小红书链接.txt`).async('nodebuffer'), linksText);
  } finally { await staged.cleanup(); }
});
