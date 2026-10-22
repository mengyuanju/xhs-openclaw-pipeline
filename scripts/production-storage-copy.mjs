import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { publishImmutableFile, withImmutableFileLock } from '../server/src/immutable-file-publication.mjs';

const OWNER = 'migration-owner.json';
const EXCLUDED = new Set(['.delivery-exports', '.task-archives', '.task-deletion-quarantine']);
const HASH = /^[a-f0-9]{64}$/u;
const MAX_JOURNAL_BYTES = 128 * 1024 ** 2;
const digest = value => createHash('sha256').update(value).digest('hex');
const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
const keyFor = path => process.platform === 'win32' ? path.normalize('NFC').toLowerCase() : path.normalize('NFC');
const maybeStat = path => lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });

function contained(root, path) {
  const difference = relative(root, path);
  return difference !== '' && !isAbsolute(difference) && difference !== '..' && !difference.startsWith(`..${sep}`);
}

function safeRelative(path) {
  assert.ok(typeof path === 'string' && path && !path.includes('\\') && !isAbsolute(path)
    && !/[\u0000-\u001f:]/u.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..'), 'Invalid migration file path');
  return path;
}

async function checkedRoot(input, { allowMissing = false, create = false } = {}) {
  assert.ok(typeof input === 'string' && isAbsolute(input), 'Storage roots must be absolute');
  const absolute = resolve(input), volume = parse(absolute).root;
  let current = await realpath(volume);
  for (const part of relative(volume, absolute).split(sep).filter(Boolean)) {
    const next = join(current, part);
    let metadata = await maybeStat(next);
    if (!metadata && create) { await mkdir(next); metadata = await lstat(next); }
    if (!metadata) { assert.ok(allowMissing, 'Storage directory does not exist'); current = next; continue; }
    assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink(), 'Storage directory ancestors must not be links');
    current = await realpath(next);
  }
  return current;
}

async function checkedFile(root, relativePath) {
  safeRelative(relativePath);
  let current = root;
  const parts = relativePath.split('/');
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const metadata = await lstat(current);
    assert.ok(!metadata.isSymbolicLink() && contained(root, await realpath(current)), 'Storage files and directories must not be links');
    if (index < parts.length - 1) assert.ok(metadata.isDirectory(), 'Storage file ancestor is not a directory');
    else { assert.ok(metadata.isFile(), 'Storage entry is not a file'); return { path: current, metadata }; }
  }
}

async function targetDirectory(root, relativePath) {
  let current = root;
  for (const part of relativePath.split('/').slice(0, -1)) {
    current = join(current, part);
    let metadata = await maybeStat(current);
    if (!metadata) { await mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error; }); metadata = await lstat(current); }
    assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink() && contained(root, await realpath(current)), 'Target directory is not a real contained directory');
  }
  return current;
}

function fingerprint(metadata) {
  return { bytes: metadata.size, mtimeMs: metadata.mtimeMs, ctimeMs: metadata.ctimeMs, ino: metadata.ino, dev: metadata.dev };
}

function unchanged(before, after) {
  return ['bytes', 'mtimeMs', 'ctimeMs', 'ino', 'dev'].every(field => before[field] === after[field]);
}

async function hashFile(path, signal) {
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(path, { signal })) {
    signal?.throwIfAborted(); hash.update(chunk); bytes += chunk.length;
  }
  return { bytes, sha256: hash.digest('hex') };
}

async function assertDisposableQuarantine(root, directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name), metadata = await lstat(path);
    assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink() && contained(root, await realpath(path)), 'Task deletion quarantine contains an invalid directory');
    const contents = await readdir(path);
    if (!contents.length) continue;
    const committed = await maybeStat(join(path, 'COMMITTED'));
    assert.ok(committed?.isFile() && !committed.isSymbolicLink(), 'Uncommitted task deletion quarantine must be resolved before storage migration');
  }
}

async function inventory(root, { source = false, signal } = {}) {
  const files = new Map(), directories = [''], excluded = [];
  const walk = async (directory, prefix = '') => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      signal?.throwIfAborted();
      const name = prefix ? `${prefix}/${entry.name}` : entry.name, path = join(directory, entry.name);
      safeRelative(name);
      const metadata = await lstat(path);
      assert.ok(!metadata.isSymbolicLink() && contained(root, await realpath(path)), 'Storage files or directories must not be links');
      if (!prefix && source && EXCLUDED.has(entry.name)) {
        assert.ok(metadata.isDirectory(), 'Excluded temporary storage entry is not a directory');
        if (entry.name === '.task-deletion-quarantine') await assertDisposableQuarantine(root, path);
        excluded.push(name); continue;
      }
      if (!prefix && !source && [OWNER, `${OWNER}.publish.lock`].includes(entry.name)) { assert.ok(metadata.isFile(), 'Migration owner marker is not a file'); continue; }
      if (!prefix && source && entry.name === OWNER) throw new Error('Source contains a reserved migration owner marker');
      if (metadata.isDirectory()) { directories.push(name); await walk(path, name); }
      else {
        assert.ok(metadata.isFile() && !files.has(keyFor(name)), 'Storage inventory contains an invalid or duplicate file');
        files.set(keyFor(name), { path: name, ...fingerprint(metadata) });
      }
    }
  };
  await walk(root);
  return { files, directories, excluded };
}

function journalDigest(input) {
  const { manifestSha256, ...manifest } = input;
  return digest(JSON.stringify(manifest));
}

async function readJson(path, limit = MAX_JOURNAL_BYTES) {
  const metadata = await lstat(path);
  assert.ok(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= limit, 'Migration metadata file is invalid');
  return JSON.parse(await readFile(path, 'utf8'));
}

function validateOwner(owner, sourceRoot, targetRoot, reportPath) {
  assert.ok(owner.format === 'xhs-production-storage-migration-owner' && owner.version === 1
    && typeof owner.migrationId === 'string' && /^[a-f0-9-]{36}$/u.test(owner.migrationId)
    && samePath(owner.sourceRoot, sourceRoot) && samePath(owner.targetRoot, targetRoot) && samePath(owner.reportPath, reportPath),
  'Target migration owner does not match this source, destination, and journal');
}

async function writeJournal(path, report, expectedDigest) {
  await checkedRoot(dirname(path), { create: true });
  const existing = await maybeStat(path);
  if (existing) {
    assert.ok(existing.isFile() && !existing.isSymbolicLink(), 'Journal path is not a real file');
    assert.equal(digest(await readFile(path)), expectedDigest, 'Migration journal was changed by another writer');
  } else assert.equal(expectedDigest, null, 'Migration journal unexpectedly disappeared');
  const temporary = `${path}.${randomUUID()}.tmp`, contents = Buffer.from(JSON.stringify(report));
  assert.ok(contents.length <= MAX_JOURNAL_BYTES, 'Migration journal exceeds its byte limit');
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(contents);
      try { await handle.sync(); } catch (error) { if (!['EINVAL', 'ENOTSUP', 'ENOSYS', 'EPERM'].includes(error.code)) throw error; }
    } finally { await handle.close(); }
    await rename(temporary, path);
    return digest(contents);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

/** Copy and verify storage bytes only. Never remove source files or update a database. */
export async function copyProductionStorage(sourceRoot, targetRoot, {
  apply = false, concurrency = 4, onProgress = () => {}, signal, reportPath,
} = {}) {
  assert.ok(Number.isSafeInteger(concurrency) && concurrency >= 1 && concurrency <= 4, 'Storage copy concurrency must be between 1 and 4');
  signal?.throwIfAborted();
  const source = await checkedRoot(sourceRoot), target = await checkedRoot(targetRoot, { allowMissing: true });
  assert.ok(!samePath(source, target) && !contained(source, target) && !contained(target, source), 'Source and target storage roots must be separate and cannot contain one another');
  if (reportPath != null) assert.ok(typeof reportPath === 'string' && isAbsolute(reportPath), 'Migration report path must be absolute');
  const requestedReportPath = resolve(reportPath ?? join(tmpdir(), 'xhs-production-storage-copy', `${digest(`${source}\n${target}`)}.json`));
  const journalPath = join(await checkedRoot(dirname(requestedReportPath), { allowMissing: true }), basename(requestedReportPath));
  assert.ok(!samePath(source, journalPath) && !samePath(target, journalPath) && !contained(source, journalPath) && !contained(target, journalPath), 'Migration journal must be outside both storage roots');
  await checkedRoot(dirname(journalPath), { allowMissing: true });
  const targetExists = await maybeStat(target), ownerPath = join(target, OWNER);
  let owner;
  if (targetExists) {
    const entries = await readdir(target);
    if (entries.length) { assert.ok(entries.includes(OWNER), 'Refusing to merge storage into an unknown nonempty directory'); owner = await readJson(ownerPath, 16_384); }
  }
  if (owner) validateOwner(owner, source, target, journalPath);
  const previousJournalMetadata = await maybeStat(journalPath);
  if (previousJournalMetadata) assert.ok(previousJournalMetadata.isFile() && !previousJournalMetadata.isSymbolicLink()
    && previousJournalMetadata.size <= MAX_JOURNAL_BYTES, 'Migration journal is not a valid metadata file');
  const previousJournalBytes = previousJournalMetadata ? await readFile(journalPath) : null;
  const previousJournal = previousJournalBytes ? JSON.parse(previousJournalBytes) : null;
  const previousJournalDigest = previousJournalBytes ? digest(previousJournalBytes) : null;
  if (previousJournal) {
    assert.ok(owner && previousJournal.format === 'xhs-production-storage-copy-journal' && previousJournal.version === 1
      && previousJournal.migrationId === owner.migrationId && samePath(previousJournal.sourceRoot, source)
      && samePath(previousJournal.targetRoot, target) && Array.isArray(previousJournal.files)
      && previousJournal.manifestSha256 === journalDigest(previousJournal),
    'Existing migration journal is invalid or does not belong to this destination');
  }
  const initial = await inventory(source, { source: true, signal });
  const totalBytes = [...initial.files.values()].reduce((sum, file) => sum + file.bytes, 0);
  const state = { format: 'xhs-production-storage-copy-journal', version: 1, migrationId: owner?.migrationId ?? randomUUID(),
    sourceRoot: source, targetRoot: target, reportPath: journalPath, createdAt: previousJournal?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(), verified: false, phase: 'inventory', totalFiles: initial.files.size, totalBytes,
    processed: 0, copied: 0, reused: 0, planned: 0, copiedBytes: 0, reusedBytes: 0, failures: [], missingFiles: [], extraFiles: [], missingDirectories: [], extraDirectories: [],
    excludedDirectories: initial.excluded, files: [] };
  const records = new Map();
  for (const record of previousJournal?.files ?? []) {
    safeRelative(record.path);
    assert.ok(Number.isSafeInteger(record.bytes) && record.bytes >= 0 && HASH.test(record.sha256) && !records.has(keyFor(record.path)), 'Migration journal file record is invalid');
    records.set(keyFor(record.path), record);
  }
  const observedTargets = new Map();
  await onProgress(structuredClone({ ...state, files: undefined }));
  if (apply) {
    await checkedRoot(target, { create: true });
    if (!owner) {
      assert.equal((await readdir(target)).length, 0, 'Target directory became nonempty before migration ownership could be recorded');
      owner = { format: 'xhs-production-storage-migration-owner', version: 1, migrationId: state.migrationId,
        sourceRoot: source, targetRoot: target, reportPath: journalPath, createdAt: state.createdAt };
      await publishImmutableFile(ownerPath, JSON.stringify(owner), { signal });
    }
  }
  const run = async () => {
    if (previousJournal) assert.equal(digest(await readFile(journalPath)), previousJournalDigest, 'Migration journal changed before its owner lock was acquired');
    let reportDigest = previousJournalDigest;
    if (apply) for (const directory of initial.directories.filter(Boolean)) {
      signal?.throwIfAborted();
      await targetDirectory(target, `${directory}/.directory-placeholder`);
    }
    let checkpointFlight = Promise.resolve(), lastProcessed = 0, lastCheckpoint = Date.now(), fatalError, latestReport;
    const report = () => {
      const value = structuredClone({ ...state, updatedAt: new Date().toISOString(), files: [...records.values()].sort((a, b) => a.path.localeCompare(b.path, 'en')) });
      value.manifestSha256 = journalDigest(value); return value;
    };
    const checkpoint = async (force = false) => {
      if (!force && state.processed - lastProcessed < 300 && Date.now() - lastCheckpoint < 5_000) return;
      lastProcessed = state.processed; lastCheckpoint = Date.now();
      const value = report();
      checkpointFlight = checkpointFlight.then(async () => {
        if (apply) reportDigest = await writeJournal(journalPath, value, reportDigest);
        await onProgress(structuredClone({ ...value, files: undefined }));
        latestReport = value;
      });
      await checkpointFlight;
    };
    const copyOne = async entry => {
      signal?.throwIfAborted();
      const sourceFile = await checkedFile(source, entry.path), before = fingerprint(sourceFile.metadata);
      assert.ok(unchanged(entry, before), 'Source changed after the initial storage inventory');
      const destination = join(target, ...entry.path.split('/'));
      const targetMetadata = targetExists || apply ? await maybeStat(destination) : null;
      if (!apply && !targetMetadata) {
        assert.ok(unchanged(before, fingerprint((await checkedFile(source, entry.path)).metadata)), 'Source changed during dry-run inventory');
        state.planned += 1; return;
      }
      const sourceHash = await hashFile(sourceFile.path, signal);
      assert.equal(sourceHash.bytes, entry.bytes, 'Source byte size changed while hashing');
      let targetHash = null;
      if (targetMetadata) { await checkedFile(target, entry.path); targetHash = await hashFile(destination, signal); }
      const previous = records.get(keyFor(entry.path));
      if (targetHash?.sha256 === sourceHash.sha256 && targetHash.bytes === sourceHash.bytes) {
        const after = fingerprint((await checkedFile(source, entry.path)).metadata);
        assert.ok(unchanged(before, after), 'Source changed while verifying an existing target');
        state.reused += 1; state.reusedBytes += entry.bytes;
        records.set(keyFor(entry.path), { path: entry.path, ...sourceHash, source: before });
        observedTargets.set(keyFor(entry.path), fingerprint((await checkedFile(target, entry.path)).metadata));
        return;
      }
      if (targetHash) assert.ok(previous && previous.bytes === targetHash.bytes && previous.sha256 === targetHash.sha256, 'Refusing to overwrite an unknown or externally changed destination file');
      if (!apply) {
        assert.ok(unchanged(before, fingerprint((await checkedFile(source, entry.path)).metadata)), 'Source changed during dry-run verification');
        state.planned += 1; return;
      }
      const directory = await targetDirectory(target, entry.path), temporary = join(directory, `.storage-copy.${state.migrationId}.${randomUUID()}.tmp`);
      try {
        signal?.throwIfAborted();
        await copyFile(sourceFile.path, temporary, constants.COPYFILE_EXCL);
        signal?.throwIfAborted();
        const copied = await hashFile(temporary, signal);
        assert.ok(copied.bytes === sourceHash.bytes && copied.sha256 === sourceHash.sha256, 'Copied target bytes do not match the source SHA256');
        assert.ok(unchanged(before, fingerprint((await checkedFile(source, entry.path)).metadata)), 'Source changed while it was being copied');
        const currentDestination = await maybeStat(destination);
        if (currentDestination) {
          await checkedFile(target, entry.path);
          const currentHash = await hashFile(destination, signal);
          assert.ok(targetHash && previous && currentHash.sha256 === previous.sha256 && currentHash.bytes === previous.bytes,
            'Destination changed after verification; refusing to overwrite it');
        } else assert.equal(targetHash, null, 'Previously verified destination unexpectedly disappeared');
        signal?.throwIfAborted();
        await rename(temporary, destination);
        records.set(keyFor(entry.path), { path: entry.path, ...sourceHash, source: before });
        observedTargets.set(keyFor(entry.path), fingerprint((await checkedFile(target, entry.path)).metadata));
        state.copied += 1; state.copiedBytes += entry.bytes;
      } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    };
    state.phase = apply ? 'copying' : 'checking';
    await checkpoint(true);
    const queue = [...initial.files.values()];
    const timer = setInterval(() => { void checkpoint(true).catch(error => { fatalError = error; }); }, 5_000);
    let workerError;
    try {
      const workers = await Promise.allSettled(Array.from({ length: concurrency }, async () => {
        while (queue.length) {
          signal?.throwIfAborted(); if (fatalError) throw fatalError;
          const entry = queue.shift();
          try { await copyOne(entry); }
          catch (error) {
            if (signal?.aborted) throw signal.reason ?? error;
            state.failures.push({ path: entry.path, error: String(error.message) });
          } finally { state.processed += 1; }
          await checkpoint();
        }
      }));
      workerError = workers.find(worker => worker.status === 'rejected')?.reason ?? fatalError;
      if (workerError) throw workerError;
      const finalSource = await inventory(source, { source: true, signal });
      const finalTarget = apply || targetExists ? await inventory(target, { signal }) : { files: new Map(), directories: [] };
      const sourceChanges = [...finalSource.files.values()].filter(file => !initial.files.has(keyFor(file.path)) || !unchanged(file, initial.files.get(keyFor(file.path)))).map(file => file.path);
      for (const file of initial.files.values()) if (!finalSource.files.has(keyFor(file.path))) sourceChanges.push(file.path);
      if (sourceChanges.length) state.failures.push({ path: null, error: 'Source inventory changed during the copy', files: sourceChanges });
      state.missingFiles = [...finalSource.files.values()].filter(file => !finalTarget.files.has(keyFor(file.path))).map(file => file.path);
      state.extraFiles = [...finalTarget.files.values()].filter(file => !finalSource.files.has(keyFor(file.path))).map(file => ({ path: file.path, bytes: file.bytes }));
      const targetDirectories = new Set(finalTarget.directories.map(keyFor)), sourceDirectories = new Set(finalSource.directories.map(keyFor));
      state.missingDirectories = finalSource.directories.filter(path => !targetDirectories.has(keyFor(path)));
      state.extraDirectories = finalTarget.directories.filter(path => !sourceDirectories.has(keyFor(path)));
      for (const file of finalTarget.files.values()) {
        const expected = observedTargets.get(keyFor(file.path));
        if (expected && !unchanged(expected, file)) state.failures.push({ path: file.path, error: 'Target changed after its SHA256 verification' });
      }
      // Keep ownership records for retained extra files, but discard records
      // whose file no longer exists at either end of a resumed migration.
      for (const key of records.keys()) if (!finalSource.files.has(key) && !finalTarget.files.has(key)) records.delete(key);
      state.verified = state.failures.length === 0 && state.missingFiles.length === 0 && state.extraFiles.length === 0
        && state.missingDirectories.length === 0 && state.extraDirectories.length === 0 && state.planned === 0 && state.processed === state.totalFiles;
      state.phase = state.verified ? 'complete' : apply ? 'incomplete' : 'planned';
      state.targetFileCount = finalTarget.files.size;
      state.sourceFileCount = finalSource.files.size;
      clearInterval(timer);
      await checkpoint(true);
      return latestReport;
    } catch (error) {
      state.phase = signal?.aborted ? 'cancelled' : 'failed';
      state.verified = false;
      await checkpoint(true).catch(() => {});
      throw error;
    } finally { clearInterval(timer); await checkpointFlight; }
  };
  return apply ? withImmutableFileLock(ownerPath, run, { signal, lockTimeoutMs: 1_000 }) : run();
}
