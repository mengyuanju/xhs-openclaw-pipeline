import assert from 'node:assert/strict';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { assertStorageServiceStopped, validateStorageCopyManifest } from './production-storage-paths.mjs';

const OWNER = 'migration-owner.json';
const EXCLUDED = new Set(['.delivery-exports', '.task-archives', '.task-deletion-quarantine']);
const FINGERPRINT = ['bytes', 'mtimeMs', 'ctimeMs', 'ino', 'dev'];
const keyFor = path => path.normalize('NFC').toLowerCase();
const fingerprint = metadata => ({ bytes: metadata.size, mtimeMs: metadata.mtimeMs,
  ctimeMs: metadata.ctimeMs, ino: metadata.ino, dev: metadata.dev });

function contained(root, path) {
  const suffix = relative(root, path);
  return suffix && !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`);
}

function safeRelative(path) {
  assert.ok(typeof path === 'string' && path && !isAbsolute(path) && !/[\\\u0000-\u001f\u007f:]/u.test(path)
    && path.split('/').every(part => part && part !== '.' && part !== '..' && !/[ .]$/u.test(part)), 'Invalid storage inventory path');
}

async function checkedRoot(input) {
  assert.ok(typeof input === 'string' && isAbsolute(input), 'Storage roots must be absolute');
  const absolute = resolve(input), volume = parse(absolute).root;
  assert.notEqual(absolute, volume, 'Storage root cannot be a volume root');
  let current = volume;
  for (const part of ['', ...relative(volume, absolute).split(sep).filter(Boolean)]) {
    current = part ? join(current, part) : current;
    const metadata = await lstat(current);
    assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink(), 'Storage root ancestors must not be links');
  }
  return realpath(absolute);
}

async function checkedMetadata(root, path) {
  const metadata = await lstat(path);
  assert.ok(!metadata.isSymbolicLink() && contained(root, await realpath(path)), 'Storage inventory must not contain links or escaped paths');
  assert.ok(metadata.isFile() || metadata.isDirectory(), 'Storage inventory contains a special file');
  return metadata;
}

async function disposableQuarantine(root, directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name), metadata = await checkedMetadata(root, path);
    assert.ok(metadata.isDirectory(), 'Task deletion quarantine contains an invalid directory');
    if (!(await readdir(path)).length) continue;
    const marker = await lstat(join(path, 'COMMITTED')).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    assert.ok(marker?.isFile() && !marker.isSymbolicLink(), 'Uncommitted task deletion quarantine must be resolved before storage cutover');
  }
}

async function inventory(root, { source, phase, totalFiles, onProgress, signal }) {
  const files = new Map(), directories = new Map([['', '']]), excluded = [];
  let visited = 0, reportedAt = Date.now();
  const progress = async force => {
    if (!force && visited % 250 !== 0 && Date.now() - reportedAt < 1000) return;
    reportedAt = Date.now();
    await onProgress({ phase, scannedFiles: files.size, scannedDirectories: directories.size,
      inspectedEntries: visited, totalFiles });
  };
  const walk = async (directory, prefix = '', omitted = false) => {
    signal?.throwIfAborted();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      signal?.throwIfAborted();
      const name = prefix ? `${prefix}/${entry.name}` : entry.name, path = join(directory, entry.name);
      safeRelative(name);
      const metadata = await checkedMetadata(root, path); visited += 1;
      if (!prefix && source && EXCLUDED.has(entry.name)) {
        assert.ok(metadata.isDirectory(), 'Excluded temporary storage entry is not a directory');
        if (entry.name === '.task-deletion-quarantine') await disposableQuarantine(root, path);
        excluded.push(entry.name);
        // These bytes are disposable, but links anywhere in storage still fail.
        await walk(path, name, true); await progress(false); continue;
      }
      if (!prefix && !source && [OWNER, `${OWNER}.publish.lock`].includes(entry.name)) {
        assert.ok(metadata.isFile(), 'Migration owner marker is not a file');
        await progress(false); continue;
      }
      if (!prefix && source && entry.name === OWNER) throw new Error('Source contains a reserved migration owner marker');
      const key = keyFor(name);
      if (metadata.isDirectory()) {
        if (!omitted) {
          assert.ok(!directories.has(key) && !files.has(key), 'Duplicate storage inventory path');
          directories.set(key, name);
        }
        await walk(path, name, omitted);
      } else if (!omitted) {
        assert.ok(!files.has(key) && !directories.has(key), 'Duplicate storage inventory path');
        files.set(key, { path: name, ...fingerprint(metadata) });
      }
      await progress(false);
    }
  };
  await progress(true); await walk(root); await progress(true);
  return { files, directories, excluded: excluded.sort() };
}

function sameKeys(actual, expected, message) {
  assert.ok(actual.size === expected.size && [...actual.keys()].every(key => expected.has(key)), message);
}

function validateSource(actual, expected) {
  sameKeys(actual.files, expected, 'Source file inventory changed after the verified copy; run a complete incremental copy');
  for (const [key, file] of expected) {
    const observed = actual.files.get(key);
    assert.ok(FINGERPRINT.every(field => observed[field] === file.source[field]),
      'Source file fingerprint changed after the verified copy; run a complete incremental copy');
  }
}

/**
 * Read-only metadata proof for a stopped production service. This deliberately
 * reads no file contents and does not prove target SHA256. Keep all writers
 * stopped until migrateProductionStoragePaths verifies every target SHA256 and
 * commits the cutover. Any changed source fingerprint requires a full copy pass.
 */
export async function verifyProductionStorageFinalInventory(sourceRoot, targetRoot, {
  manifest, assertOffline = assertStorageServiceStopped, onProgress = () => {}, signal,
} = {}) {
  signal?.throwIfAborted();
  const files = validateStorageCopyManifest(manifest, sourceRoot, targetRoot);
  assert.ok(['missingDirectories', 'extraDirectories'].every(key => Array.isArray(manifest[key]) && manifest[key].length === 0),
    'A verified copy with complete directory inventories is required');
  for (const file of files.values()) {
    assert.ok(file.source && FINGERPRINT.every(field => typeof file.source[field] === 'number' && Number.isFinite(file.source[field]))
      && file.source.bytes === file.bytes, 'Verified copy is missing a complete source file fingerprint');
  }
  await assertOffline();
  const source = await checkedRoot(sourceRoot), target = await checkedRoot(targetRoot);
  assert.ok(keyFor(source) !== keyFor(target) && !contained(source, target) && !contained(target, source),
    'Source and target roots must be separate');
  validateStorageCopyManifest(manifest, source, target);
  const options = { totalFiles: files.size, onProgress, signal };
  const before = await inventory(source, { ...options, source: true, phase: 'source-inventory' });
  validateSource(before, files);
  const destination = await inventory(target, { ...options, source: false, phase: 'target-inventory' });
  sameKeys(destination.files, files, 'Target file inventory differs from the verified copy');
  for (const [key, file] of files) assert.equal(destination.files.get(key).bytes, file.bytes, 'Target file size differs from the verified copy');
  sameKeys(destination.directories, before.directories, 'Source and target directory inventories differ, including empty directories');
  // The second source metadata pass also catches changes while target metadata
  // was being enumerated. It still performs no image or attachment byte reads.
  const after = await inventory(source, { ...options, source: true, phase: 'source-recheck' });
  validateSource(after, files);
  sameKeys(after.directories, before.directories, 'Source directory inventory changed during final verification');
  signal?.throwIfAborted();
  await assertOffline();
  return { phase: 'inventory-confirmed', sourceRoot: source, targetRoot: target,
    files: files.size, bytes: manifest.totalBytes, directories: after.directories.size,
    excludedDirectories: after.excluded, sourceUnchangedSinceCopy: true,
    targetInventoryMatchesSource: true, targetSha256Verified: false, requiresTargetSha256Verification: true };
}
