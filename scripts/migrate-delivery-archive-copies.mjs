import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { normalizeTaskId, normalizeUuid } from '../server/src/domain.mjs';
import { loadDeliverySnapshot, saveDeliverySnapshot, verifyDeliverySnapshotSources } from '../server/src/delivery-snapshots.mjs';
import { connectDatabase, isMain, loadConfiguration, safeError } from '../server/scripts/database-common.mjs';
import { publishImmutableFile } from '../server/src/immutable-file-publication.mjs';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const BATCH_FILE = new RegExp(`^(${UUID})\\.zip$`, 'iu');
const AGGREGATE_FILE = new RegExp(`^(${UUID})-([1-9]\\d*)\\.zip$`, 'iu');
const INTEGER = /^[1-9]\d*$/u;
const HASH = /^[a-f0-9]{64}$/u;
const MAX_JSON_BYTES = 64 * 1024 ** 2;
const digest = value => createHash('sha256').update(value).digest('hex');

function inside(root, path) {
  const difference = relative(root, resolve(path));
  return difference !== '' && !isAbsolute(difference) && difference !== '..' && !difference.startsWith(`..${sep}`);
}

async function checkedRoot(input) {
  assert.ok(typeof input === 'string' && isAbsolute(input), 'Storage roots must be absolute paths');
  const path = resolve(input), volume = parse(path).root;
  let current = volume;
  for (const part of relative(volume, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    const metadata = await lstat(current);
    assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink(), 'Storage root ancestors must be real directories');
  }
  return realpath(path);
}

async function checkedPath(root, path, { optional = false, directory = false } = {}) {
  assert.ok(inside(root, path), 'Storage path is outside the configured root');
  let current = root, metadata;
  for (const part of relative(root, resolve(path)).split(sep)) {
    current = join(current, part);
    metadata = await lstat(current).catch(error => {
      if (optional && error.code === 'ENOENT') return null;
      throw error;
    });
    if (!metadata) return null;
    assert.ok(!metadata.isSymbolicLink(), 'Linked storage files or directories are not allowed');
    assert.ok(inside(root, await realpath(current)), 'Resolved storage path is outside the configured root');
  }
  assert.ok(directory ? metadata.isDirectory() : metadata.isFile(), 'Unexpected storage file type');
  return metadata;
}

async function jsonDirectory(root) {
  const path = join(root, '.delivery-snapshots');
  if (!(await checkedPath(root, path, { optional: true, directory: true }))) await mkdir(path);
  await checkedPath(root, path, { directory: true });
  return path;
}

function archiveInfo(input) {
  const sha256 = String(input?.sha256 ?? ''), byteSize = Number(input?.byteSize);
  assert.ok(HASH.test(sha256) && Number.isSafeInteger(byteSize) && byteSize > 0, 'Archive checksum metadata is invalid');
  return { sha256, byteSize };
}

async function verifyArchive(root, path, expected) {
  const metadata = await checkedPath(root, path);
  assert.equal(metadata.size, expected.byteSize, 'Archive byte size does not match its frozen record');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  assert.equal(hash.digest('hex'), expected.sha256, 'Archive SHA256 does not match its frozen record');
  return metadata;
}

async function removeVerifiedArchive(root, path, verified) {
  const current = await checkedPath(root, path);
  for (const field of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(current[field], verified[field], 'Archive changed after verification');
  await rm(path);
}

function sidecarDigest(sidecar) {
  const { manifestSha256, ...manifest } = sidecar;
  return digest(JSON.stringify(manifest));
}

function normalizeMembers(input) {
  assert.ok(Array.isArray(input) && input.length > 0 && input.length <= 100_000, 'Aggregate frozen members are required');
  const used = new Set();
  return input.map(raw => {
    assert.ok(raw && typeof raw === 'object' && !Array.isArray(raw), 'Aggregate frozen member is invalid');
    const member = JSON.parse(JSON.stringify(raw.snapshot ?? raw));
    member.item_id = normalizeTaskId(member.item_id ?? raw.item_id);
    assert.ok(!used.has(member.item_id), 'Aggregate frozen member IDs are duplicated');
    used.add(member.item_id);
    member.task_id = normalizeTaskId(member.task_id);
    member.batch_public_id = normalizeUuid(member.batch_public_id, 'batchId');
    const source = archiveInfo({ sha256: member.source_sha256, byteSize: member.source_byte_size });
    member.source_sha256 = source.sha256; member.source_byte_size = source.byteSize;
    return member;
  });
}

function normalizeJob(input) {
  const id = normalizeTaskId(input?.id), runToken = normalizeUuid(input?.run_token ?? input?.runToken, 'runToken');
  assert.ok(input.status === 'SUCCEEDED', 'Aggregate job is not a successful frozen job');
  const members = normalizeMembers(input.members);
  assert.ok(Array.isArray(input.artifacts) && input.artifacts.length > 0, 'Aggregate artifacts are required');
  const memberIds = new Set(members.map(member => member.item_id)), used = new Set();
  const artifacts = input.artifacts.map(raw => {
    const part = normalizeTaskId(raw.part), expected = archiveInfo(raw);
    assert.ok(!used.has(part), 'Aggregate artifact parts are duplicated'); used.add(part);
    const file = `${runToken}-${part}.zip`;
    if (raw.file != null) assert.equal(String(raw.file).toLowerCase(), file, 'Aggregate artifact filename does not match its run token');
    assert.ok(Array.isArray(raw.itemIds) && raw.itemIds.length > 0, 'Aggregate artifact membership is required');
    const itemIds = raw.itemIds.map(normalizeTaskId);
    assert.ok(new Set(itemIds).size === itemIds.length && itemIds.every(itemId => memberIds.has(itemId)), 'Aggregate artifact membership does not match its frozen selection');
    return { part, file, fileName: String(raw.fileName ?? `HG-${id}-${part}-交付内容.zip`), ...expected, itemIds };
  });
  if (input.item_count != null || input.itemCount != null) assert.equal(Number(input.item_count ?? input.itemCount), members.length, 'Aggregate item count does not match its frozen selection');
  return { id, runToken, kind: input.kind ?? null, status: input.status, itemCount: members.length,
    createdAt: input.created_at ?? input.createdAt ?? null, finishedAt: input.finished_at ?? input.finishedAt ?? null,
    artifacts, members };
}

async function saveAggregateSidecar(root, jobs) {
  const directory = await jsonDirectory(root), path = join(directory, 'aggregate-jobs.json');
  const metadata = await checkedPath(root, path, { optional: true });
  let existing = { version: 1, jobs: [] };
  if (metadata) {
    assert.ok(metadata.size <= MAX_JSON_BYTES, 'Aggregate metadata sidecar is too large');
    existing = JSON.parse(await readFile(path, 'utf8'));
    assert.ok(existing.version === 1 && Array.isArray(existing.jobs) && existing.manifestSha256 === sidecarDigest(existing), 'Aggregate metadata sidecar checksum is invalid');
  }
  const combined = new Map(existing.jobs.map(job => [`${job.id}:${job.runToken}`, job]));
  for (const job of jobs) {
    const key = `${job.id}:${job.runToken}`, previous = combined.get(key);
    assert.ok(!previous || JSON.stringify(previous) === JSON.stringify(job), 'Existing aggregate metadata cannot be replaced by different frozen members');
    combined.set(key, job);
  }
  const sidecar = { version: 1, jobs: [...combined.values()].sort((a, b) => a.id - b.id || a.runToken.localeCompare(b.runToken)) };
  sidecar.manifestSha256 = sidecarDigest(sidecar);
  const contents = JSON.stringify(sidecar);
  assert.ok(Buffer.byteLength(contents) <= MAX_JSON_BYTES, 'Aggregate metadata sidecar is too large');
  if (!metadata) {
    await publishImmutableFile(path, contents);
    return;
  }
  const temporary = join(directory, `aggregate-jobs.${randomUUID()}.tmp`);
  await writeFile(temporary, contents, { flag: 'wx' });
  try {
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}

async function scanArchives(root) {
  const batches = [], aggregates = [], skipped = [];
  const batchDirectory = join(root, '.delivery-batches'), aggregateDirectory = join(root, '.delivery-archives');
  const hasBatches = await checkedPath(root, batchDirectory, { optional: true, directory: true });
  const hasAggregates = await checkedPath(root, aggregateDirectory, { optional: true, directory: true });
  if (hasBatches) for (const entry of await readdir(batchDirectory, { withFileTypes: true })) {
    const match = BATCH_FILE.exec(entry.name), path = join(batchDirectory, entry.name);
    if (match) { await checkedPath(root, path); batches.push({ publicId: normalizeUuid(match[1]), path }); }
    else skipped.push(relative(root, path));
  }
  if (hasAggregates) for (const entry of await readdir(aggregateDirectory, { withFileTypes: true })) {
    const directory = join(aggregateDirectory, entry.name);
    if (!INTEGER.test(entry.name)) { skipped.push(relative(root, directory)); continue; }
    const jobId = normalizeTaskId(entry.name);
    await checkedPath(root, directory, { directory: true });
    for (const file of await readdir(directory, { withFileTypes: true })) {
      const match = AGGREGATE_FILE.exec(file.name), path = join(directory, file.name);
      if (!match) { skipped.push(relative(root, path)); continue; }
      await checkedPath(root, path);
      aggregates.push({ jobId, runToken: normalizeUuid(match[1]), part: normalizeTaskId(match[2]), path, file: file.name });
    }
  }
  return { batches, aggregates, skipped };
}

/** Migrate backup copies without reading live tasks, copying images, or writing a database. */
export async function migrateDeliveryArchiveCopies(canonicalRoot, targetRoot, {
  apply = false, removeArchives = false, aggregateJobs = [],
} = {}) {
  assert.ok(!removeArchives || apply, 'Removing ZIPs requires --apply');
  const canonical = await checkedRoot(canonicalRoot), target = await checkedRoot(targetRoot);
  assert.notEqual(canonical.toLowerCase(), target.toLowerCase(), 'A backup target must differ from canonical storage');
  await checkedPath(canonical, join(canonical, '.delivery-snapshots'), { directory: true });
  const scanned = await scanArchives(target), canonicalSnapshots = new Map(), snapshots = new Map(), saved = new Set();
  const result = { batches: scanned.batches.length, snapshots: 0, reused: 0, aggregateFiles: scanned.aggregates.length,
    aggregateJobs: 0, removedFiles: 0, removedBytes: 0, skipped: scanned.skipped, failures: [] };
  const canonicalSnapshot = async publicId => {
    publicId = normalizeUuid(publicId, 'batchId');
    if (!canonicalSnapshots.has(publicId)) {
      await checkedPath(canonical, join(canonical, '.delivery-snapshots', `${publicId}.json`));
      canonicalSnapshots.set(publicId, await loadDeliverySnapshot(canonical, publicId));
    }
    return canonicalSnapshots.get(publicId);
  };
  const ensureSnapshot = async (publicId, expected) => {
    publicId = normalizeUuid(publicId, 'batchId');
    let snapshot = snapshots.get(publicId);
    if (!snapshot) {
      snapshot = await canonicalSnapshot(publicId);
      for (const file of snapshot.entries) if (file.kind === 'image') await checkedPath(target, resolve(target, ...file.storagePath.split('/')));
      await verifyDeliverySnapshotSources(target, snapshot);
      snapshots.set(publicId, snapshot);
    }
    if (expected) {
      assert.equal(snapshot.sourceArchive.sha256, expected.sha256, 'Canonical snapshot does not match the frozen source SHA256');
      assert.equal(snapshot.sourceArchive.byteSize, expected.byteSize, 'Canonical snapshot does not match the frozen source byte size');
    }
    if (!saved.has(publicId)) {
      const existingPath = join(target, '.delivery-snapshots', `${publicId}.json`);
      const existing = await checkedPath(target, existingPath, { optional: true });
      if (existing) {
        assert.deepEqual(await loadDeliverySnapshot(target, publicId), snapshot, 'Target snapshot conflicts with the canonical snapshot');
        result.reused += 1;
      }
      if (apply) await saveDeliverySnapshot(target, snapshot);
      saved.add(publicId); result.snapshots += 1;
    }
    return snapshot;
  };
  let batchFailures = 0;
  for (const batch of scanned.batches) {
    try {
      const snapshot = await canonicalSnapshot(batch.publicId);
      const metadata = await verifyArchive(target, batch.path, snapshot.sourceArchive);
      await ensureSnapshot(batch.publicId);
      if (removeArchives) {
        await removeVerifiedArchive(target, batch.path, metadata);
        result.removedFiles += 1; result.removedBytes += metadata.size;
      }
    } catch (error) {
      batchFailures += 1;
      result.failures.push({ kind: 'batch', publicId: batch.publicId, error: String(error.message) });
    }
  }
  const jobs = new Map();
  for (const input of aggregateJobs) {
    const id = Number(input?.id);
    if (jobs.has(id)) throw new TypeError('Aggregate job IDs are duplicated');
    jobs.set(id, input);
  }
  const verified = [], metadataJobs = new Map();
  for (const artifact of scanned.aggregates) {
    try {
      assert.equal(batchFailures, 0, 'A batch ZIP in this backup is not reconstructable; aggregate ZIPs must be retained');
      const input = jobs.get(artifact.jobId);
      assert.ok(input, 'Aggregate ZIP has no matching frozen job metadata');
      const job = normalizeJob(input);
      assert.equal(job.runToken, artifact.runToken, 'Aggregate ZIP run token does not match the frozen job');
      const expected = job.artifacts.find(part => part.part === artifact.part);
      assert.ok(expected, 'Aggregate ZIP part is absent from the frozen job');
      assert.equal(expected.file, artifact.file.toLowerCase(), 'Aggregate ZIP filename does not match the frozen artifact');
      const metadata = await verifyArchive(target, artifact.path, expected);
      for (const member of job.members) {
        const snapshot = await ensureSnapshot(member.batch_public_id, archiveInfo({ sha256: member.source_sha256, byteSize: member.source_byte_size }));
        assert.ok(snapshot.members.some(source => source.taskId === member.task_id), 'Aggregate frozen task is absent from its source snapshot');
      }
      metadataJobs.set(`${job.id}:${job.runToken}`, job);
      verified.push({ artifact, metadata });
    } catch (error) {
      result.failures.push({ kind: 'aggregate', jobId: artifact.jobId, file: artifact.file, error: String(error.message) });
    }
  }
  if (apply && metadataJobs.size) {
    await saveAggregateSidecar(target, [...metadataJobs.values()]);
    result.aggregateJobs = metadataJobs.size;
    if (removeArchives) for (const { artifact, metadata } of verified) {
      await removeVerifiedArchive(target, artifact.path, metadata);
      result.removedFiles += 1; result.removedBytes += metadata.size;
    }
  } else result.aggregateJobs = metadataJobs.size;
  return result;
}

export async function loadDeliveryArchiveCopyJobs(client) {
  const jobs = (await client.query(`SELECT id,run_token,status,kind,item_count,artifacts,created_at,finished_at
    FROM delivery_archive_jobs ORDER BY id`)).rows;
  const items = (await client.query('SELECT job_id,item_id,snapshot FROM delivery_archive_items ORDER BY job_id,item_id')).rows;
  return jobs.map(job => ({ ...job, members: items.filter(item => Number(item.job_id) === Number(job.id)).map(item => {
    assert.ok(item.snapshot && typeof item.snapshot === 'object' && !Array.isArray(item.snapshot), 'Archived member snapshot is invalid');
    if (item.snapshot.item_id != null) assert.equal(Number(item.snapshot.item_id), Number(item.item_id), 'Archived member ID does not match its frozen row');
    return { ...item.snapshot, item_id: Number(item.item_id) };
  }) }));
}

export async function main(args = process.argv.slice(2)) {
  const targets = args.filter(arg => arg.startsWith('--target-root='));
  assert.ok(targets.length === 1 && args.filter(arg => arg === '--environment=production').length === 1
    && args.every(arg => arg.startsWith('--target-root=') || ['--environment=production', '--apply', '--remove-archives'].includes(arg)),
  'Use --target-root=ABS --environment=production [--apply] [--remove-archives]');
  const target = targets[0].slice('--target-root='.length);
  assert.ok(isAbsolute(target), '--target-root must be absolute');
  const config = loadConfiguration({ args: ['--environment=production'], environment: {} });
  const client = connectDatabase(config);
  try {
    await client.connect();
    await client.query('BEGIN TRANSACTION READ ONLY');
    const aggregateJobs = await loadDeliveryArchiveCopyJobs(client);
    await client.query('COMMIT');
    const result = await migrateDeliveryArchiveCopies(config.environment.CONTROL_PLANE_STORAGE_ROOT, target, {
      apply: args.includes('--apply'), removeArchives: args.includes('--remove-archives'), aggregateJobs,
    });
    console.log(JSON.stringify({ profile: config.profile, targetRoot: target, result }));
    if (result.failures.length) process.exitCode = 1;
  } catch (error) { console.error(safeError(error, config)); process.exitCode = 1; }
  finally { await client.end(); }
}

if (isMain(import.meta.url)) await main();
