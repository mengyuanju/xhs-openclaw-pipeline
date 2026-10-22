import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDeliverySnapshot } from '../server/src/delivery-snapshots.mjs';
import { normalizeTaskId, normalizeUuid } from '../server/src/domain.mjs';
import { publishImmutableFile } from '../server/src/immutable-file-publication.mjs';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const BATCH = new RegExp(`^\\.delivery-batches/(${UUID})\\.zip$`, 'iu');
const AGGREGATE = new RegExp(`^\\.delivery-archives/([1-9]\\d*)/(${UUID})-([1-9]\\d*)\\.zip$`, 'iu');
const SNAPSHOT = new RegExp(`^\\.delivery-snapshots/(?:${UUID}|aggregate-jobs)\\.json$`, 'iu');
const AUDIT_FILE = /^delivery-snapshot-reconciliation\.[a-f0-9]{64}\.json$/u;
const HASH = /^[a-f0-9]{64}$/u;
const MAX_JSON_BYTES = 128 * 1024 ** 2;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const keyFor = path => path.normalize('NFC').toLowerCase();
const samePath = (left, right) => resolve(left).toLowerCase() === resolve(right).toLowerCase();

function inside(root, path) {
  const difference = relative(root, path);
  return difference !== '' && !isAbsolute(difference) && difference !== '..' && !difference.startsWith(`..${sep}`);
}

async function realDirectory(input) {
  assert.ok(typeof input === 'string' && isAbsolute(input), 'Backup storage root must be absolute');
  const path = resolve(input), volume = parse(path).root;
  let current = volume;
  for (const part of relative(volume, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    const metadata = await lstat(current);
    assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink(), 'Linked backup directories are not allowed');
  }
  return realpath(path);
}

async function realFile(parent, name) {
  assert.equal(basename(name), name, 'Backup metadata filename is invalid');
  const path = join(parent, name), metadata = await lstat(path);
  assert.ok(metadata.isFile() && !metadata.isSymbolicLink() && inside(parent, await realpath(path)), 'Backup metadata must be a real contained file');
  assert.ok(metadata.size <= MAX_JSON_BYTES, 'Backup metadata file is too large');
  return path;
}

function safeRelative(path) {
  assert.ok(typeof path === 'string' && path && !path.includes('\\') && !isAbsolute(path)
    && !/[\u0000-\u001f:]/u.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..'), 'Backup inventory path is invalid');
  return path;
}

function checksumObject(input) {
  const { manifestSha256, ...contents } = input;
  return digest(JSON.stringify(contents));
}

async function inventory(root) {
  const files = new Map(), directories = [''];
  const walk = async (directory, prefix = '') => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name), name = prefix ? `${prefix}/${entry.name}` : entry.name;
      safeRelative(name);
      const metadata = await lstat(path);
      assert.ok(!metadata.isSymbolicLink() && inside(root, await realpath(path)), 'Linked storage files or directories are not allowed');
      if (metadata.isDirectory()) { directories.push(name); await walk(path, name); }
      else {
        assert.ok(metadata.isFile() && !files.has(keyFor(name)), 'Storage inventory contains an invalid or duplicate file');
        files.set(keyFor(name), { path: name, bytes: metadata.size, absolutePath: path });
      }
    }
  };
  await walk(root);
  directories.sort((a, b) => a.localeCompare(b, 'en'));
  return { files, directories };
}

async function immutableJson(parent, name, contents) {
  await publishImmutableFile(join(parent, name), contents, {
    compareExisting: async (path, existing) => {
      await realFile(parent, name);
      assert.equal(digest(existing), digest(contents), 'An immutable backup audit file conflicts with this reconciliation');
      return true;
    },
  });
}

async function replaceJson(parent, name, contents, expectedSha256) {
  const path = await realFile(parent, name);
  assert.equal(digest(await readFile(path)), expectedSha256, 'Backup metadata changed while reconciliation was running');
  const temporary = join(parent, `${name}.${randomUUID()}.tmp`);
  await writeFile(temporary, contents, { flag: 'wx' });
  try { await rename(temporary, path); }
  finally { await unlink(temporary).catch(() => {}); }
}

/** Update only a pre-upgrade storage backup's inventory after verified ZIP migration. */
export async function reconcileStorageBackupManifest(targetRoot, { apply = false } = {}) {
  const target = await realDirectory(targetRoot), parent = dirname(target);
  assert.equal(basename(target).toLowerCase(), 'storage', 'Only a backupParent/storage directory may be reconciled');
  const manifestPath = await realFile(parent, 'storage-manifest.json'), reportPath = await realFile(parent, 'backup-report.json');
  const originalManifest = await readFile(manifestPath), originalReport = await readFile(reportPath);
  const previousManifestSha256 = digest(originalManifest), previousReportSha256 = digest(originalReport);
  const manifest = JSON.parse(originalManifest), report = JSON.parse(originalReport);
  assert.ok(manifest.format === 'xhs-control-plane-storage-backup' && manifest.version === 1, 'Unsupported storage backup manifest');
  assert.ok(typeof manifest.destination === 'string' && samePath(manifest.destination, target), 'Manifest destination does not match this backup storage root');
  assert.ok(report.storage && samePath(report.storage.destination, target) && samePath(report.storage.manifest, manifestPath), 'Backup report does not identify this storage manifest');
  if (report.folder != null) assert.ok(samePath(report.folder, parent), 'Backup report folder does not match the backup parent');
  assert.ok(Array.isArray(manifest.files) && manifest.files.length <= 200_000 && Array.isArray(manifest.directories), 'Backup inventory is invalid');
  const oldFiles = new Map();
  let declaredBytes = 0;
  for (const file of manifest.files) {
    safeRelative(file.path);
    assert.ok(Number.isSafeInteger(file.bytes) && file.bytes >= 0 && HASH.test(file.sha256) && !oldFiles.has(keyFor(file.path)), 'Original backup file metadata is invalid');
    oldFiles.set(keyFor(file.path), file); declaredBytes += file.bytes;
  }
  assert.equal(declaredBytes, manifest.bytes, 'Original backup byte total is inconsistent');
  let pendingAudit;
  if (report.storage.manifestSha256 !== previousManifestSha256) {
    assert.ok(AUDIT_FILE.test(manifest.reconciliation?.auditFile ?? ''), 'Backup report manifest checksum does not match');
    pendingAudit = JSON.parse(await readFile(await realFile(parent, manifest.reconciliation.auditFile), 'utf8'));
    assert.ok(pendingAudit.format === 'xhs-storage-delivery-snapshot-reconciliation-audit'
      && pendingAudit.manifestSha256 === checksumObject(pendingAudit)
      && pendingAudit.nextManifestSha256 === previousManifestSha256
      && pendingAudit.previousReportSha256 === previousReportSha256, 'Pending backup reconciliation audit does not match the files');
    assert.equal(digest(Buffer.from(pendingAudit.nextReportBase64, 'base64')), pendingAudit.nextReportSha256, 'Pending report recovery checksum is invalid');
  } else for (const [field, expected] of Object.entries({ expectedFiles: oldFiles.size, verifiedFiles: oldFiles.size, expectedBytes: declaredBytes, verifiedBytes: declaredBytes })) {
    assert.equal(report.storage[field], expected, 'Backup report inventory totals do not match its manifest');
  }
  const current = await inventory(target), removedArchiveFiles = [], addedSnapshotFiles = [], files = [];
  for (const old of oldFiles.values()) {
    const actual = current.files.get(keyFor(old.path));
    if (!actual) {
      assert.ok(BATCH.test(old.path) || AGGREGATE.test(old.path), `An original non-delivery file is missing: ${old.path}`);
      removedArchiveFiles.push(old); continue;
    }
    assert.equal(actual.bytes, old.bytes, `An original file byte size changed: ${old.path}`);
    if (SNAPSHOT.test(old.path)) assert.equal(digest(await readFile(actual.absolutePath)), old.sha256, 'An existing snapshot metadata file changed');
    files.push({ ...old, path: actual.path });
  }
  for (const actual of current.files.values()) if (!oldFiles.has(keyFor(actual.path))) {
    assert.ok(SNAPSHOT.test(actual.path), `Unexpected new storage file: ${actual.path}`);
    const file = { path: actual.path, bytes: actual.bytes, sha256: digest(await readFile(actual.absolutePath)) };
    addedSnapshotFiles.push(file); files.push(file);
  }
  const snapshots = new Map();
  const snapshotFor = async publicId => {
    publicId = normalizeUuid(publicId, 'batchId');
    if (!snapshots.has(publicId)) {
      assert.ok(current.files.has(keyFor(`.delivery-snapshots/${publicId}.json`)), 'A migrated delivery archive has no retained reconstruction snapshot');
      const snapshot = await loadDeliverySnapshot(target, publicId);
      for (const image of snapshot.entries.filter(file => file.kind === 'image')) {
        const original = oldFiles.get(keyFor(image.storagePath)), actual = current.files.get(keyFor(image.storagePath));
        assert.ok(original && actual && original.sha256 === image.sha256 && original.bytes === image.byteSize && actual.bytes === image.byteSize,
          'Snapshot image metadata does not match an unchanged original backup file');
      }
      snapshots.set(publicId, snapshot);
    }
    return snapshots.get(publicId);
  };
  let aggregateSidecar;
  const aggregateJobs = async () => {
    if (!aggregateSidecar) {
      const file = current.files.get(keyFor('.delivery-snapshots/aggregate-jobs.json'));
      assert.ok(file, 'Removed aggregate archives have no retained frozen job metadata');
      aggregateSidecar = JSON.parse(await readFile(file.absolutePath, 'utf8'));
      assert.ok(aggregateSidecar.version === 1 && Array.isArray(aggregateSidecar.jobs)
        && aggregateSidecar.manifestSha256 === checksumObject(aggregateSidecar), 'Aggregate metadata checksum is invalid');
    }
    return aggregateSidecar.jobs;
  };
  for (const file of removedArchiveFiles) {
    const batch = BATCH.exec(file.path);
    if (batch) {
      const snapshot = await snapshotFor(batch[1]);
      assert.ok(snapshot.sourceArchive.sha256 === file.sha256 && snapshot.sourceArchive.byteSize === file.bytes, 'Removed batch ZIP does not match its retained snapshot');
    } else {
      const match = AGGREGATE.exec(file.path), jobId = normalizeTaskId(match[1]), runToken = normalizeUuid(match[2]), part = normalizeTaskId(match[3]);
      const job = (await aggregateJobs()).find(item => item.id === jobId && item.runToken === runToken);
      const artifact = job?.artifacts?.find(item => item.part === part && item.file === `${runToken}-${part}.zip`);
      assert.ok(artifact && artifact.sha256 === file.sha256 && artifact.byteSize === file.bytes, 'Removed aggregate ZIP does not match its frozen job metadata');
      assert.ok(Array.isArray(job.members) && job.members.length > 0, 'Frozen aggregate members are missing');
      for (const member of job.members) {
        const snapshot = await snapshotFor(member.batch_public_id);
        assert.ok(snapshot.sourceArchive.sha256 === member.source_sha256 && snapshot.sourceArchive.byteSize === Number(member.source_byte_size)
          && snapshot.members.some(source => source.taskId === Number(member.task_id)), 'Frozen aggregate member does not match its retained source snapshot');
      }
    }
  }
  for (const file of addedSnapshotFiles) {
    const name = file.path.slice('.delivery-snapshots/'.length, -'.json'.length);
    if (name.toLowerCase() === 'aggregate-jobs') await aggregateJobs();
    else await snapshotFor(name);
  }
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const directoryChanged = JSON.stringify([...manifest.directories].sort((a, b) => a.localeCompare(b, 'en'))) !== JSON.stringify(current.directories);
  const changed = Boolean(removedArchiveFiles.length || addedSnapshotFiles.length || directoryChanged);
  const result = { changed: changed || Boolean(pendingAudit), removedArchives: removedArchiveFiles.length, addedSnapshots: addedSnapshotFiles.length,
    files: files.length, bytes, manifestSha256: previousManifestSha256 };
  if (pendingAudit) {
    assert.ok(!changed, 'Recover the pending report before making another inventory change');
    if (apply) await replaceJson(parent, 'backup-report.json', Buffer.from(pendingAudit.nextReportBase64, 'base64'), previousReportSha256);
    return { ...result, recoveredReport: true };
  }
  if (!changed) return result;
  const reconciledAt = new Date().toISOString(), auditFile = `delivery-snapshot-reconciliation.${previousManifestSha256}.json`;
  const manifestBackup = `storage-manifest.before-delivery-snapshots.${previousManifestSha256}.json`;
  const reportBackup = `backup-report.before-delivery-snapshots.${previousReportSha256}.json`;
  const audit = { format: 'xhs-storage-delivery-snapshot-reconciliation-audit', version: 1, reconciledAt,
    originalManifestSha256: manifest.reconciliation?.originalManifestSha256 ?? previousManifestSha256,
    previousManifestSha256, previousReportSha256, manifestBackup, reportBackup, auditFile,
    removedArchiveFiles, addedSnapshotFiles,
    verification: { originalFileSha256Reused: true, originalFileExistenceAndSizeVerified: true,
      newSnapshotSha256Computed: true, imagesRehashed: false, linksFollowed: false } };
  const reconciliation = { auditFile, reconciledAt, originalManifestSha256: audit.originalManifestSha256,
    previousManifestSha256, previousReportSha256, removedArchives: removedArchiveFiles.length, addedSnapshots: addedSnapshotFiles.length,
    verification: audit.verification };
  const nextManifest = { ...manifest, files, bytes, directories: current.directories,
    reconciliation, reconciliationHistory: [...(manifest.reconciliationHistory ?? []), auditFile] };
  const nextManifestBytes = jsonBytes(nextManifest), nextManifestSha256 = digest(nextManifestBytes);
  const nextReport = { ...report, storage: { ...report.storage, expectedFiles: files.length, expectedBytes: bytes,
    verifiedFiles: files.length, verifiedBytes: bytes, manifestSha256: nextManifestSha256, verifiedAt: reconciledAt,
    reconciliation, reconciliationHistory: [...(report.storage.reconciliationHistory ?? []), auditFile] } };
  const nextReportBytes = jsonBytes(nextReport);
  Object.assign(audit, { nextManifestSha256, nextReportSha256: digest(nextReportBytes), nextReportBase64: nextReportBytes.toString('base64') });
  audit.manifestSha256 = checksumObject(audit);
  if (apply) {
    await immutableJson(parent, manifestBackup, originalManifest);
    await immutableJson(parent, reportBackup, originalReport);
    await immutableJson(parent, auditFile, jsonBytes(audit));
    await replaceJson(parent, 'storage-manifest.json', nextManifestBytes, previousManifestSha256);
    await replaceJson(parent, 'backup-report.json', nextReportBytes, previousReportSha256);
  }
  return { ...result, manifestSha256: nextManifestSha256, auditFile };
}

export async function main(args = process.argv.slice(2)) {
  const targets = args.filter(arg => arg.startsWith('--target-root='));
  assert.ok(targets.length === 1 && args.every(arg => arg.startsWith('--target-root=') || arg === '--apply'), 'Use --target-root=ABS [--apply]');
  const result = await reconcileStorageBackupManifest(targets[0].slice('--target-root='.length), { apply: args.includes('--apply') });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (error) { console.error(String(error.message)); process.exitCode = 1; }
}
