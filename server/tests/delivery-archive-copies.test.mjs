import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import JSZip from 'jszip';
import { loadDeliveryArchiveCopyJobs, migrateDeliveryArchiveCopies } from '../../scripts/migrate-delivery-archive-copies.mjs';
import { createDeliverySnapshot, inspectSnapshotSources, loadDeliverySnapshot, saveDeliverySnapshot, stageSnapshotBatchArchive } from '../src/delivery-snapshots.mjs';
import { writeDeliveryAggregate } from '../src/delivery-archives.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const exists = path => access(path).then(() => true, () => false);
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhN0AAAAASUVORK5CYII=', 'base64');

async function fixture(t) {
  const temporary = await mkdtemp(join(tmpdir(), 'xhs-archive-copy-test-')), root = await realpath(temporary);
  t.after(async () => {
    assert.ok(temporary.startsWith(join(tmpdir(), 'xhs-archive-copy-test-')));
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const canonical = join(root, 'canonical'), target = join(root, 'backup');
  for (const storage of [canonical, target]) {
    await mkdir(join(storage, '1'), { recursive: true });
    await mkdir(join(storage, '.delivery-batches'));
    await writeFile(join(storage, '1', 'frozen.png'), image);
  }
  const publicId = randomUUID(), runToken = randomUUID(), directory = '历史批次/任务-1-资源包';
  const text = Buffer.from('\uFEFF原始 Query：冻结问题\r\n\r\n标题：冻结标题\r\n\r\n文案内容：\r\n冻结正文\r\n');
  const zip = new JSZip();
  zip.file(`${directory}/文案.txt`, text);
  zip.file(`${directory}/01.png`, image);
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const canonicalArchive = join(canonical, '.delivery-batches', `${publicId}.zip`), batchPath = join(target, '.delivery-batches', `${publicId}.zip`);
  await writeFile(canonicalArchive, bytes);
  await writeFile(batchPath, bytes);
  const snapshot = await createDeliverySnapshot(canonical, canonicalArchive, publicId, { resolveImage: async () => ({ storagePath: '1/frozen.png' }) });
  await saveDeliverySnapshot(canonical, snapshot);
  await rm(canonicalArchive);
  const row = { item_id: 19, task_id: 1, batch_public_id: publicId, source_sha256: hash(bytes), source_byte_size: bytes.length, issued_query: '冻结问题', query: '冻结问题' };
  const aggregateBytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const aggregateFile = `${runToken}-1.zip`, aggregateDirectory = join(target, '.delivery-archives', '7');
  await mkdir(aggregateDirectory, { recursive: true });
  const aggregatePath = join(aggregateDirectory, aggregateFile);
  await writeFile(aggregatePath, aggregateBytes);
  const job = { id: 7, run_token: runToken, status: 'SUCCEEDED', kind: 'DOWNLOAD', item_count: 1,
    artifacts: [{ part: 1, file: aggregateFile, fileName: 'HG-7-1-交付内容.zip', byteSize: aggregateBytes.length, sha256: hash(aggregateBytes), itemIds: [19] }], members: [row] };
  return { root, canonical, target, publicId, batchPath, bytes, aggregatePath, aggregateBytes, job, directory, text };
}

test('backup-copy dry run checks exact archives and target originals without saving or deleting files', async t => {
  const data = await fixture(t);
  const result = await migrateDeliveryArchiveCopies(data.canonical, data.target, { aggregateJobs: [data.job] });
  assert.deepEqual(result.failures, []);
  assert.equal(result.batches, 1);
  assert.equal(result.aggregateFiles, 1);
  assert.equal(result.aggregateJobs, 1);
  assert.equal(result.removedFiles, 0);
  assert.equal(await exists(join(data.target, '.delivery-snapshots')), false);
  assert.deepEqual(await readFile(data.batchPath), data.bytes);
  assert.deepEqual(await readFile(data.aggregatePath), data.aggregateBytes);
  await assert.rejects(migrateDeliveryArchiveCopies(data.canonical, data.target, { removeArchives: true }), /--apply/u);
});

test('backup-copy migration preserves reconstruction snapshots and frozen aggregate metadata before removing ZIP copies', async t => {
  const data = await fixture(t);
  const result = await migrateDeliveryArchiveCopies(data.canonical, data.target, { apply: true, removeArchives: true, aggregateJobs: [data.job] });
  assert.deepEqual(result.failures, []);
  assert.equal(result.removedFiles, 2);
  assert.equal(await exists(data.batchPath), false);
  assert.equal(await exists(data.aggregatePath), false);
  assert.deepEqual(await readFile(join(data.target, '1', 'frozen.png')), image);
  assert.deepEqual(await readdir(join(data.target, '1')), ['frozen.png'], 'no image is duplicated');
  const snapshot = await loadDeliverySnapshot(data.target, data.publicId);
  const staged = await stageSnapshotBatchArchive(data.target, snapshot);
  try {
    const restored = await JSZip.loadAsync(await readFile(staged.archivePath));
    assert.deepEqual(await restored.file(`${data.directory}/01.png`).async('nodebuffer'), image);
    assert.deepEqual(await restored.file(`${data.directory}/文案.txt`).async('nodebuffer'), data.text);
  } finally { await staged.cleanup(); }
  const sidecar = JSON.parse(await readFile(join(data.target, '.delivery-snapshots', 'aggregate-jobs.json'), 'utf8'));
  const { manifestSha256, ...manifest } = sidecar;
  assert.equal(manifestSha256, hash(JSON.stringify(manifest)));
  assert.equal(sidecar.jobs[0].members[0].issued_query, '冻结问题');
  assert.equal(sidecar.jobs[0].artifacts[0].sha256, data.job.artifacts[0].sha256);
  const members = await inspectSnapshotSources(data.target, sidecar.jobs[0].members);
  const aggregate = await writeDeliveryAggregate(data.target, { id: 7, run_token: data.job.run_token }, members.members);
  try {
    const restored = await JSZip.loadAsync(await readFile(aggregate[0].path));
    assert.deepEqual(await restored.file(`${data.directory}/01.png`).async('nodebuffer'), image);
  } finally { await aggregate[0].cleanup(); }
});

test('missing target originals preserve all ZIPs and never copy canonical images into the backup', async t => {
  const data = await fixture(t);
  await rm(join(data.target, '1', 'frozen.png'));
  const result = await migrateDeliveryArchiveCopies(data.canonical, data.target, { apply: true, removeArchives: true, aggregateJobs: [data.job] });
  assert.equal(result.failures.length, 2);
  assert.equal(result.removedFiles, 0);
  assert.equal(await exists(data.batchPath), true);
  assert.equal(await exists(data.aggregatePath), true);
  assert.equal(await exists(join(data.target, '1', 'frozen.png')), false);
  assert.equal(await exists(join(data.target, '.delivery-snapshots')), false);
});

test('source ZIP hash mismatches preserve the file and do not save a misleading snapshot', async t => {
  const data = await fixture(t), changed = Buffer.from(data.bytes);
  changed[0] ^= 1;
  await writeFile(data.batchPath, changed);
  const result = await migrateDeliveryArchiveCopies(data.canonical, data.target, { apply: true, removeArchives: true, aggregateJobs: [data.job] });
  assert.equal(result.failures.length, 2);
  assert.equal(result.removedFiles, 0);
  assert.deepEqual(await readFile(data.batchPath), changed);
  assert.equal(await exists(join(data.target, '.delivery-snapshots')), false);
});

test('unknown ZIPs and database backups are untouched and mismatched aggregates cannot be deleted', async t => {
  const data = await fixture(t), database = join(data.target, 'database-backup.zip'), unknown = join(data.target, '.delivery-batches', 'unknown.zip');
  await writeFile(database, 'database bytes');
  await writeFile(unknown, 'unknown bytes');
  const job = structuredClone(data.job);
  job.artifacts[0].sha256 = '0'.repeat(64);
  const result = await migrateDeliveryArchiveCopies(data.canonical, data.target, { apply: true, removeArchives: true, aggregateJobs: [job] });
  assert.equal(result.failures.length, 1);
  assert.equal(result.removedFiles, 1);
  assert.equal(await exists(data.aggregatePath), true);
  assert.equal(await readFile(database, 'utf8'), 'database bytes');
  assert.equal(await readFile(unknown, 'utf8'), 'unknown bytes');
  assert.deepEqual(result.skipped, [join('.delivery-batches', 'unknown.zip')]);
  assert.equal(await exists(join(data.target, '.delivery-snapshots', 'aggregate-jobs.json')), false);
});

test('backup-copy publication and removal are idempotent and existing frozen metadata stays exact', async t => {
  const data = await fixture(t), options = { apply: true, aggregateJobs: [data.job] };
  const first = await migrateDeliveryArchiveCopies(data.canonical, data.target, options);
  assert.deepEqual(first.failures, []);
  assert.equal(await exists(data.batchPath), true);
  const sidecarPath = join(data.target, '.delivery-snapshots', 'aggregate-jobs.json'), sidecar = await readFile(sidecarPath);
  const second = await migrateDeliveryArchiveCopies(data.canonical, data.target, options);
  assert.equal(second.reused, 1);
  assert.deepEqual(second.failures, []);
  assert.deepEqual(await readFile(sidecarPath), sidecar);
  const removed = await migrateDeliveryArchiveCopies(data.canonical, data.target, { ...options, removeArchives: true });
  assert.equal(removed.removedFiles, 2);
  const fourth = await migrateDeliveryArchiveCopies(data.canonical, data.target, { ...options, removeArchives: true });
  assert.equal(fourth.removedFiles, 0);
  assert.deepEqual(fourth.failures, []);
  assert.deepEqual(await readFile(sidecarPath), sidecar);
});

test('linked archive directories are rejected before any external ZIP can be removed', async t => {
  const data = await fixture(t), outside = join(data.root, 'outside');
  await mkdir(outside);
  const path = join(outside, `${data.publicId}.zip`);
  await writeFile(path, data.bytes);
  await rm(data.batchPath);
  await rm(join(data.target, '.delivery-batches'), { recursive: true });
  try { await symlink(outside, join(data.target, '.delivery-batches'), 'junction'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('symlinks unavailable'); return; } throw error; }
  await assert.rejects(migrateDeliveryArchiveCopies(data.canonical, data.target, { apply: true, removeArchives: true, aggregateJobs: [data.job] }), /Linked storage/u);
  assert.deepEqual(await readFile(path), data.bytes);
  assert.equal(await exists(data.aggregatePath), true);
});

test('linked image ancestors cannot substitute external originals even when their bytes match', async t => {
  const data = await fixture(t), outside = join(data.root, 'outside-images');
  await mkdir(outside);
  await writeFile(join(outside, 'frozen.png'), image);
  await rm(join(data.target, '1'), { recursive: true });
  try { await symlink(outside, join(data.target, '1'), 'junction'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('symlinks unavailable'); return; } throw error; }
  const result = await migrateDeliveryArchiveCopies(data.canonical, data.target, { apply: true, removeArchives: true, aggregateJobs: [data.job] });
  assert.equal(result.removedFiles, 0);
  assert.equal(result.failures.length, 2);
  assert.deepEqual(await readFile(data.batchPath), data.bytes);
});

test('aggregate job loading uses only frozen SELECTs and never reads live tasks or writes the database', async () => {
  const calls = [], runToken = randomUUID(), publicId = randomUUID();
  const member = { item_id: 19, task_id: 1, batch_public_id: publicId, source_sha256: 'a'.repeat(64), source_byte_size: 123, issued_query: '冻结问题' };
  const client = { async query(sql) {
    calls.push(sql);
    if (sql.includes('FROM delivery_archive_jobs')) return { rows: [{ id: 7, run_token: runToken, status: 'SUCCEEDED', artifacts: [] }] };
    if (sql.includes('FROM delivery_archive_items')) return { rows: [{ job_id: 7, item_id: 19, snapshot: member }] };
    throw new Error('unexpected SQL');
  } };
  const jobs = await loadDeliveryArchiveCopyJobs(client);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(sql => /^SELECT\s/u.test(sql)));
  assert.ok(calls.every(sql => !/\btasks\b/u.test(sql)));
  assert.deepEqual(jobs[0].members, [member]);
});
