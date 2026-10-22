import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import JSZip from 'jszip';
import { migrateDeliverySnapshots } from '../../scripts/migrate-delivery-snapshots.mjs';
import { loadDeliverySnapshot, stageSnapshotBatchArchive } from '../src/delivery-snapshots.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const exists = path => access(path).then(() => true, () => false);

async function storage(t) {
  const temporary = await mkdtemp(join(tmpdir(), 'xhs-snapshot-migration-'));
  const root = await realpath(temporary);
  t.after(async () => {
    assert.ok(temporary.startsWith(join(tmpdir(), 'xhs-snapshot-migration-')));
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await mkdir(join(root, '.delivery-batches'));
  return root;
}

async function source(root, taskId = 1, { missingImage = false } = {}) {
  const publicId = randomUUID(), image = Buffer.from([0, 255, taskId]), directory = `历史批次/任务-${taskId}-资源包`;
  const zip = new JSZip();
  zip.file(`${directory}/文案.txt`, `\uFEFF原始 Query：初始问题${taskId}\r\n\r\n标题：标题${taskId}\r\n\r\n文案内容：\r\n历史正文${taskId}\r\n`);
  zip.file(`${directory}/01.png`, image);
  const archive = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const archivePath = join(root, '.delivery-batches', `${publicId}.zip`), imagePath = join(root, String(taskId), 'frozen.png');
  await writeFile(archivePath, archive);
  await mkdir(join(root, String(taskId)));
  if (!missingImage) await writeFile(imagePath, image);
  return {
    batch: { id: taskId, public_id: publicId, archive_sha256: hash(archive), archive_byte_size: archive.length },
    asset: { id: taskId + 10, task_id: taskId, storage_path: imagePath, sha256: hash(image), byte_size: image.length, content_cleared_at: null },
    archivePath, imagePath, image, directory,
  };
}

function fakeClient(sources, { jobs = [], activeJobs = [] } = {}) {
  const client = { calls: [], refs: new Map(), committed: 0, rolledBack: 0 };
  let originalRefs;
  client.query = async (rawSql, values = []) => {
    const sql = rawSql.replace(/\s+/gu, ' ').trim();
    client.calls.push({ sql, values });
    if (sql === 'BEGIN') { originalRefs = new Map(client.refs); return { rows: [] }; }
    if (sql === 'COMMIT') { client.committed += 1; return { rows: [] }; }
    if (sql === 'ROLLBACK') { client.refs = originalRefs; client.rolledBack += 1; return { rows: [] }; }
    if (sql.startsWith('SELECT id,public_id,archive_sha256,archive_byte_size FROM delivery_batches')) return { rows: sources.map(item => item.batch) };
    if (sql.includes("FROM assets WHERE media_type LIKE 'image/%'")) return { rows: sources.map(item => item.asset) };
    if (sql.startsWith('SELECT id FROM tasks ')) return { rows: values[0].map(id => ({ id })) };
    if (sql.startsWith('SELECT pg_advisory_xact_lock(')) return { rows: [] };
    if (sql.includes('FROM assets WHERE storage_path=ANY(')) return { rows: sources.map(item => item.asset).filter(asset => values[0].includes(asset.storage_path)) };
    if (sql.startsWith('INSERT INTO delivery_snapshot_assets(')) {
      const [publicId, path, sha256, byteSize, taskId, assetId] = values;
      client.refs.set(`${publicId}:${path}`, { publicId, path, sha256, byteSize, taskId, assetId });
      return { rows: [{ storage_path: path }], rowCount: 1 };
    }
    if (sql.startsWith('SELECT id FROM delivery_archive_jobs WHERE status IN')) return { rows: activeJobs.map(id => ({ id })) };
    if (sql === 'SELECT id FROM delivery_archive_jobs') return { rows: jobs.map(id => ({ id })) };
    throw new Error(`Unexpected migration query: ${sql}`);
  };
  return client;
}

test('migration dry run verifies original bytes without writing snapshot files, references or deleting ZIPs', async t => {
  const root = await storage(t), item = await source(root), client = fakeClient([item]);
  const before = await readFile(item.archivePath);
  const result = await migrateDeliverySnapshots(client, root);
  assert.equal(result.snapshots, 1);
  assert.deepEqual(result.failures, []);
  assert.equal(result.removedFiles, 0);
  assert.equal(client.refs.size, 0);
  assert.equal(client.committed, 0);
  assert.deepEqual(await readFile(item.archivePath), before);
  assert.deepEqual(await readdir(join(root, '.delivery-snapshots')), []);
  await assert.rejects(migrateDeliverySnapshots(client, root, { removeArchives: true }), /--apply/u);
});

test('applying migration registers immutable image references and snapshots can rebuild after ZIP deletion', async t => {
  const root = await storage(t), item = await source(root), client = fakeClient([item]);
  const result = await migrateDeliverySnapshots(client, root, { apply: true });
  assert.equal(result.snapshots, 1);
  assert.deepEqual(result.failures, []);
  assert.equal(client.committed, 1);
  assert.equal(client.refs.size, 1);
  assert.equal(client.refs.values().next().value.path, item.imagePath);
  assert.equal(await exists(item.archivePath), true, 'apply alone retains the existing archive');
  await rm(item.archivePath);
  const snapshot = await loadDeliverySnapshot(root, item.batch.public_id);
  const staged = await stageSnapshotBatchArchive(root, snapshot);
  try {
    const restored = await JSZip.loadAsync(await readFile(staged.archivePath));
    assert.deepEqual(await restored.file(`${item.directory}/01.png`).async('nodebuffer'), item.image);
    assert.match(await restored.file(`${item.directory}/文案.txt`).async('string'), /历史正文1/u);
  } finally { await staged.cleanup(); }
  const next = await migrateDeliverySnapshots(client, root, { apply: true, removeArchives: true });
  assert.equal(next.reused, 1);
  assert.deepEqual(next.failures, []);
  assert.equal(next.removedFiles, 0);
  assert.equal(client.refs.size, 1, 'reapplying keeps one durable reference');
});

test('removing archives deletes only verified batches and known aggregates while retaining original images', async t => {
  const root = await storage(t), item = await source(root), client = fakeClient([item], { jobs: [31] });
  const directory = join(root, '.delivery-archives', '31');
  await mkdir(directory, { recursive: true });
  const aggregate = join(directory, `${randomUUID()}-1.zip`);
  await writeFile(aggregate, 'old derived aggregate');
  await writeFile(join(directory, 'unrelated.zip'), 'preserve unknown file');
  const result = await migrateDeliverySnapshots(client, root, { apply: true, removeArchives: true });
  assert.deepEqual(result.failures, []);
  assert.equal(result.removedFiles, 2);
  assert.equal(await exists(item.archivePath), false);
  assert.equal(await exists(aggregate), false);
  assert.equal(await exists(join(directory, 'unrelated.zip')), true);
  assert.deepEqual(await readFile(item.imagePath), item.image);
  const second = await migrateDeliverySnapshots(client, root, { apply: true, removeArchives: true });
  assert.equal(second.reused, 1);
  assert.equal(second.removedFiles, 0);
  assert.deepEqual(second.failures, []);
});

test('failed batches keep their original ZIP and aggregate archives remain until all sources are verified', async t => {
  const root = await storage(t), good = await source(root), bad = await source(root, 2, { missingImage: true });
  const client = fakeClient([good, bad], { jobs: [31] });
  const directory = join(root, '.delivery-archives', '31');
  await mkdir(directory, { recursive: true });
  const aggregate = join(directory, `${randomUUID()}-1.zip`);
  await writeFile(aggregate, 'keep while a source is not reconstructable');
  const original = await readFile(bad.archivePath);
  const result = await migrateDeliverySnapshots(client, root, { apply: true, removeArchives: true });
  assert.equal(result.snapshots, 1);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].publicId, bad.batch.public_id);
  assert.deepEqual(await readFile(bad.archivePath), original);
  assert.equal(await exists(aggregate), true);
  assert.equal(client.refs.size, 1);
});

test('migration refuses linked archive directories and never deletes archives outside the storage root', async t => {
  const root = await storage(t), item = await source(root), client = fakeClient([item]);
  const outside = await mkdtemp(join(tmpdir(), 'xhs-snapshot-migration-outside-'));
  t.after(async () => {
    assert.ok(outside.startsWith(join(tmpdir(), 'xhs-snapshot-migration-outside-')));
    await rm(outside, { recursive: true, force: true });
  });
  const bytes = await readFile(item.archivePath), externalArchive = join(outside, `${item.batch.public_id}.zip`);
  await writeFile(externalArchive, bytes);
  await rm(item.archivePath);
  await rm(join(root, '.delivery-batches'), { recursive: true });
  try { await symlink(outside, join(root, '.delivery-batches'), 'junction'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('symlinks unavailable'); return; } throw error; }
  const result = await migrateDeliverySnapshots(client, root, { apply: true, removeArchives: true });
  assert.equal(result.failures.length, 1);
  assert.deepEqual(await readFile(externalArchive), bytes);
});

test('dry run revalidates images in reused snapshots and reports missing originals without deleting ZIPs', async t => {
  const root = await storage(t), item = await source(root), client = fakeClient([item]);
  await migrateDeliverySnapshots(client, root, { apply: true });
  await rm(item.imagePath);
  const zip = await readFile(item.archivePath);
  const result = await migrateDeliverySnapshots(client, root);
  assert.equal(result.reused, 1);
  assert.equal(result.snapshots, 0);
  assert.equal(result.failures.length, 1);
  assert.deepEqual(await readFile(item.archivePath), zip);
});

test('active archive workers prevent all ZIP deletion before migration starts', async t => {
  const root = await storage(t), item = await source(root), client = fakeClient([item], { jobs: [31], activeJobs: [31] });
  const zip = await readFile(item.archivePath);
  await assert.rejects(migrateDeliverySnapshots(client, root, { apply: true, removeArchives: true }), /must be idle/u);
  assert.deepEqual(await readFile(item.archivePath), zip);
  assert.equal(client.refs.size, 0);
});

test('linked aggregate directories cannot delete files outside storage', async t => {
  const root = await storage(t), item = await source(root), client = fakeClient([item], { jobs: [31] });
  const outside = await mkdtemp(join(tmpdir(), 'xhs-snapshot-aggregate-outside-'));
  t.after(async () => {
    assert.ok(outside.startsWith(join(tmpdir(), 'xhs-snapshot-aggregate-outside-')));
    await rm(outside, { recursive: true, force: true });
  });
  const externalArchive = join(outside, `${randomUUID()}-1.zip`);
  await writeFile(externalArchive, 'outside aggregate must remain');
  await mkdir(join(root, '.delivery-archives'));
  try { await symlink(outside, join(root, '.delivery-archives', '31'), 'junction'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('symlinks unavailable'); return; } throw error; }
  await assert.rejects(migrateDeliverySnapshots(client, root, { apply: true, removeArchives: true }), /Linked storage/u);
  assert.equal(await readFile(externalArchive, 'utf8'), 'outside aggregate must remain');
});
