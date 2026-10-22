import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import JSZip from 'jszip';
import { reconcileStorageBackupManifest } from '../../scripts/reconcile-storage-backup-manifest.mjs';
import { createDeliverySnapshot, saveDeliverySnapshot } from '../src/delivery-snapshots.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhN0AAAAASUVORK5CYII=', 'base64');

async function tree(root) {
  const files = [];
  const visit = async (directory, prefix = '') => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name), name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await visit(path, `${name}/`);
      else files.push([name, (await readFile(path)).toString('base64')]);
    }
  };
  await visit(root);
  return files.sort(([left], [right]) => left.localeCompare(right));
}

async function fixture(t) {
  const temporary = await mkdtemp(join(tmpdir(), 'xhs-storage-reconcile-'));
  const root = await realpath(temporary), parent = join(root, 'pre-upgrade-fixture'), storage = join(parent, 'storage');
  t.after(async () => {
    assert.ok(temporary.startsWith(join(tmpdir(), 'xhs-storage-reconcile-')));
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await mkdir(join(storage, '1'), { recursive: true });
  await mkdir(join(storage, '.delivery-batches'));
  await writeFile(join(storage, '1', 'frozen.png'), image);
  const publicId = randomUUID(), batchRelative = `.delivery-batches/${publicId}.zip`;
  const batchPath = join(storage, '.delivery-batches', `${publicId}.zip`);
  const zip = new JSZip();
  zip.file('历史批次/任务-1-资源包/01.png', image);
  zip.file('历史批次/任务-1-资源包/文案.txt', '\uFEFF原始 Query：冻结问题\r\n\r\n标题：冻结标题\r\n\r\n文案内容：\r\n冻结正文\r\n');
  const archive = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  await writeFile(batchPath, archive);
  const snapshot = await createDeliverySnapshot(storage, batchPath, publicId, { resolveImage: async () => ({ storagePath: '1/frozen.png' }) });
  const manifest = { format: 'xhs-control-plane-storage-backup', version: 1,
    createdAt: '2026-10-02T11:31:35.863Z', source: join(root, 'source-images'), destination: storage,
    files: [{ path: batchRelative, bytes: archive.length, sha256: hash(archive) },
      { path: '1/frozen.png', bytes: image.length, sha256: hash(image) }],
    bytes: archive.length + image.length, directories: ['', '.delivery-batches', '1'],
    validation: { sourceAndDestinationSha256Matched: true, sourceUnchangedDuringCopy: true,
      destinationInventoryMatched: true, linksFollowed: false } };
  const manifestPath = join(parent, 'storage-manifest.json'), reportPath = join(parent, 'backup-report.json');
  const manifestBytes = jsonBytes(manifest);
  const report = { format: 'xhs-production-pre-upgrade-backup-report', version: 1, phase: 'COMPLETE',
    database: { status: 'VERIFIED', archiveSha256: 'a'.repeat(64), sqlSha256: 'b'.repeat(64),
      databaseName: 'xhs_control_prod', tables: 31, rows: 1400, restoreExecuted: false },
    storage: { source: manifest.source, destination: storage, manifest: manifestPath,
      status: 'VERIFIED', expectedFiles: manifest.files.length, expectedBytes: manifest.bytes,
      verifiedFiles: manifest.files.length, verifiedBytes: manifest.bytes,
      manifestSha256: hash(manifestBytes), verifiedAt: manifest.createdAt } };
  const reportBytes = jsonBytes(report);
  await writeFile(manifestPath, manifestBytes);
  await writeFile(reportPath, reportBytes);
  await saveDeliverySnapshot(storage, snapshot);
  await rm(batchPath);
  return { root, parent, storage, publicId, snapshot, batchRelative, batchPath, archive,
    manifest, report, manifestPath, reportPath, manifestBytes, reportBytes };
}

async function resetMetadata(data) {
  data.manifest.bytes = data.manifest.files.reduce((sum, file) => sum + file.bytes, 0);
  data.manifestBytes = jsonBytes(data.manifest);
  data.report.storage.manifestSha256 = hash(data.manifestBytes);
  for (const prefix of ['expected', 'verified']) {
    data.report.storage[`${prefix}Files`] = data.manifest.files.length;
    data.report.storage[`${prefix}Bytes`] = data.manifest.bytes;
  }
  data.reportBytes = jsonBytes(data.report);
  await writeFile(data.manifestPath, data.manifestBytes);
  await writeFile(data.reportPath, data.reportBytes);
}

test('storage reconciliation dry run proves replacement snapshots without writing manifest, report, backups, or audit', async t => {
  const data = await fixture(t), before = await tree(data.parent);
  const result = await reconcileStorageBackupManifest(data.storage);
  assert.equal(result.changed, true);
  assert.equal(result.removedArchives, 1);
  assert.equal(result.addedSnapshots, 1);
  assert.equal(result.files, 2);
  assert.match(result.manifestSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(await tree(data.parent), before);
});

test('apply preserves original bytes, updates counts and digest, and keeps database backup metadata intact', async t => {
  const data = await fixture(t);
  const result = await reconcileStorageBackupManifest(data.storage, { apply: true });
  assert.equal(result.changed, true);
  assert.equal(result.removedArchives, 1);
  assert.equal(result.addedSnapshots, 1);
  const manifestBytes = await readFile(data.manifestPath), manifest = JSON.parse(manifestBytes);
  const report = JSON.parse(await readFile(data.reportPath, 'utf8'));
  const snapshotRelative = `.delivery-snapshots/${data.publicId}.json`;
  const snapshotBytes = await readFile(join(data.storage, '.delivery-snapshots', `${data.publicId}.json`));
  assert.equal(manifest.files.some(file => file.path === data.batchRelative), false);
  assert.deepEqual(manifest.files.find(file => file.path === snapshotRelative), {
    path: snapshotRelative, bytes: snapshotBytes.length, sha256: hash(snapshotBytes),
  });
  assert.deepEqual(manifest.files.find(file => file.path === '1/frozen.png'), data.manifest.files[1]);
  const expectedBytes = image.length + snapshotBytes.length;
  assert.equal(manifest.bytes, expectedBytes);
  assert.equal(result.files, 2);
  assert.equal(result.bytes, expectedBytes);
  assert.equal(result.manifestSha256, hash(manifestBytes));
  assert.equal(report.storage.manifestSha256, hash(manifestBytes));
  assert.equal(report.storage.expectedFiles, 2);
  assert.equal(report.storage.verifiedFiles, 2);
  assert.equal(report.storage.expectedBytes, expectedBytes);
  assert.equal(report.storage.verifiedBytes, expectedBytes);
  assert.deepEqual(report.database, data.report.database);
  const parentFiles = await readdir(data.parent);
  const originals = parentFiles.filter(name => name.includes('.before-delivery-snapshots.') && name.endsWith('.json'));
  assert.equal(originals.length, 2);
  const oldContents = await Promise.all(originals.map(name => readFile(join(data.parent, name))));
  assert.ok(oldContents.some(bytes => bytes.equals(data.manifestBytes)));
  assert.ok(oldContents.some(bytes => bytes.equals(data.reportBytes)));
  const auditFiles = parentFiles.filter(name => name.endsWith('.json') && !['storage-manifest.json', 'backup-report.json'].includes(name) && !originals.includes(name));
  assert.equal(auditFiles.length, 1, 'one reconciliation audit is saved beside the metadata');
  const audit = JSON.parse(await readFile(join(data.parent, auditFiles[0]), 'utf8'));
  assert.ok(Array.isArray(audit.removedArchiveFiles));
  assert.ok(Array.isArray(audit.addedSnapshotFiles));
  assert.equal(audit.removedArchiveFiles.length, 1);
  assert.equal(audit.addedSnapshotFiles.length, 1);
});

test('existing image checksums are reused without reading and rehashing image contents', async t => {
  const data = await fixture(t), changed = Buffer.from(image);
  changed[changed.length - 1] ^= 1;
  assert.notEqual(hash(changed), hash(image));
  await writeFile(join(data.storage, '1', 'frozen.png'), changed);
  await reconcileStorageBackupManifest(data.storage, { apply: true });
  const manifest = JSON.parse(await readFile(data.manifestPath, 'utf8'));
  assert.equal(manifest.files.find(file => file.path === '1/frozen.png').sha256, hash(image));
  assert.deepEqual(await readFile(join(data.storage, '1', 'frozen.png')), changed);
});

test('missing ordinary files and size changes refuse reconciliation without changing metadata', async t => {
  for (const mode of ['missing', 'size']) await t.test(mode, async child => {
    const data = await fixture(child);
    if (mode === 'missing') await rm(join(data.storage, '1', 'frozen.png'));
    else await writeFile(join(data.storage, '1', 'frozen.png'), Buffer.concat([image, Buffer.from('extra')]));
    const before = await tree(data.parent);
    await assert.rejects(reconcileStorageBackupManifest(data.storage, { apply: true }));
    assert.deepEqual(await tree(data.parent), before);
  });
});

test('missing batch archives require a snapshot whose original archive digest and size match the old manifest', async t => {
  for (const field of ['sha256', 'bytes']) await t.test(field, async child => {
    const data = await fixture(child), archive = data.manifest.files[0];
    archive[field] = field === 'sha256' ? '0'.repeat(64) : archive.bytes + 1;
    await resetMetadata(data);
    const before = await tree(data.parent);
    await assert.rejects(reconcileStorageBackupManifest(data.storage, { apply: true }));
    assert.deepEqual(await tree(data.parent), before);
  });
});

test('unknown additions and unknown missing ZIP files cannot be silently absorbed', async t => {
  for (const mode of ['new-image', 'new-zip', 'missing-unknown-zip']) await t.test(mode, async child => {
    const data = await fixture(child);
    if (mode === 'new-image') await writeFile(join(data.storage, '1', 'unknown.png'), image);
    else if (mode === 'new-zip') await writeFile(join(data.storage, 'unknown.zip'), 'unknown data');
    else {
      data.manifest.files.push({ path: 'database-backup.zip', bytes: 12, sha256: 'e'.repeat(64) });
      await resetMetadata(data);
    }
    const before = await tree(data.parent);
    await assert.rejects(reconcileStorageBackupManifest(data.storage, { apply: true }));
    assert.deepEqual(await tree(data.parent), before);
  });
});

test('frozen aggregate sidecar proves deleted aggregate ZIP and is added with its exact JSON digest', async t => {
  const data = await fixture(t), runToken = randomUUID(), aggregate = Buffer.from('already verified aggregate archive');
  const relative = `.delivery-archives/7/${runToken}-1.zip`;
  data.manifest.files.push({ path: relative, bytes: aggregate.length, sha256: hash(aggregate) });
  data.manifest.directories.push('.delivery-archives', '.delivery-archives/7');
  await mkdir(join(data.storage, '.delivery-archives', '7'), { recursive: true });
  await resetMetadata(data);
  const sidecar = { version: 1, jobs: [{ id: 7, runToken, kind: 'DOWNLOAD', status: 'SUCCEEDED', itemCount: 1,
    createdAt: null, finishedAt: null,
    artifacts: [{ part: 1, file: `${runToken}-1.zip`, fileName: 'HG-7-1-交付内容.zip', byteSize: aggregate.length, sha256: hash(aggregate), itemIds: [19] }],
    members: [{ item_id: 19, task_id: 1, batch_public_id: data.publicId, source_sha256: hash(data.archive), source_byte_size: data.archive.length,
      issued_query: '冻结问题', query: '冻结问题' }] }] };
  sidecar.manifestSha256 = hash(JSON.stringify(sidecar));
  const sidecarBytes = Buffer.from(JSON.stringify(sidecar));
  await writeFile(join(data.storage, '.delivery-snapshots', 'aggregate-jobs.json'), sidecarBytes);
  const result = await reconcileStorageBackupManifest(data.storage, { apply: true });
  assert.equal(result.removedArchives, 2);
  assert.equal(result.addedSnapshots, 2);
  const manifest = JSON.parse(await readFile(data.manifestPath, 'utf8'));
  assert.equal(manifest.files.some(file => file.path === relative), false);
  assert.deepEqual(manifest.files.find(file => file.path.endsWith('/aggregate-jobs.json')), {
    path: '.delivery-snapshots/aggregate-jobs.json', bytes: sidecarBytes.length, sha256: hash(sidecarBytes),
  });
});

test('storage directory links are rejected before metadata can be replaced', async t => {
  const data = await fixture(t), outside = join(data.root, 'outside-images');
  await mkdir(outside);
  await writeFile(join(outside, 'frozen.png'), image);
  await rm(join(data.storage, '1'), { recursive: true });
  try { await symlink(outside, join(data.storage, '1'), 'junction'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('directory links unavailable'); return; } throw error; }
  assert.equal((await lstat(join(data.storage, '1'))).isSymbolicLink(), true);
  await assert.rejects(reconcileStorageBackupManifest(data.storage, { apply: true }));
  assert.deepEqual(await readFile(data.manifestPath), data.manifestBytes);
  assert.deepEqual(await readFile(data.reportPath), data.reportBytes);
  assert.deepEqual(await readFile(join(outside, 'frozen.png')), image);
});

test('manifest and report checksum disagreement blocks reconciliation', async t => {
  const data = await fixture(t);
  data.report.storage.manifestSha256 = 'f'.repeat(64);
  await writeFile(data.reportPath, jsonBytes(data.report));
  const before = await tree(data.parent);
  await assert.rejects(reconcileStorageBackupManifest(data.storage, { apply: true }));
  assert.deepEqual(await tree(data.parent), before);
});

test('reconciliation requires an absolute backup storage root', async t => {
  const data = await fixture(t);
  await assert.rejects(reconcileStorageBackupManifest('storage', { apply: true }));
  await assert.rejects(reconcileStorageBackupManifest(data.parent, { apply: true }));
});

test('a second apply is unchanged and writes no additional backup or audit', async t => {
  const data = await fixture(t);
  await reconcileStorageBackupManifest(data.storage, { apply: true });
  const before = await tree(data.parent);
  const result = await reconcileStorageBackupManifest(data.storage, { apply: true });
  assert.equal(result.changed, false);
  assert.equal(result.removedArchives, 0);
  assert.equal(result.addedSnapshots, 0);
  assert.deepEqual(await tree(data.parent), before);
});
