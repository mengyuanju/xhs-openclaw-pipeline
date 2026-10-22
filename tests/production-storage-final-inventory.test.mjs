import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { copyProductionStorage } from '../scripts/production-storage-copy.mjs';
import { verifyProductionStorageFinalInventory } from '../scripts/production-storage-final-inventory.mjs';

function seal(manifest) {
  const { manifestSha256, ...contents } = manifest;
  manifest.manifestSha256 = createHash('sha256').update(JSON.stringify(contents)).digest('hex');
}

async function removeWithin(root, path) {
  const suffix = relative(resolve(root), resolve(path));
  assert.ok(suffix && !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`));
  await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

async function fixture(t) {
  const temporary = await mkdtemp(join(tmpdir(), 'xhs-final-inventory-tests-')), root = await realpath(temporary);
  t.after(async () => {
    const suffix = relative(resolve(tmpdir()), resolve(temporary));
    assert.ok(suffix && !isAbsolute(suffix) && suffix.startsWith('xhs-final-inventory-tests-') && !suffix.includes(sep));
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  const source = join(root, 'source'), target = join(root, 'target');
  for (const [name, contents] of [
    ['tasks/1/original.png', 'fixture original image'],
    ['.delivery-snapshots/fixture.json', '{"fixture":"relative-path-only"}'],
    ['attachments/info.txt', 'fixture attachment'],
    ['.delivery-exports/disposable.zip', 'temporary export'],
    ['.task-archives/disposable.zip', 'temporary task archive'],
    ['.task-deletion-quarantine/committed/COMMITTED', 'committed'],
    ['.task-deletion-quarantine/committed/deleted.png', 'discarded image'],
  ]) {
    const path = join(source, ...name.split('/'));
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, contents);
  }
  await mkdir(join(source, 'empty', 'nested'), { recursive: true });
  const manifest = await copyProductionStorage(source, target, { apply: true, reportPath: join(root, 'journal.json') });
  assert.equal(manifest.verified, true);
  return { root, source, target, manifest, image: join(source, 'tasks', '1', 'original.png'),
    options: { manifest, assertOffline: async () => {} } };
}

async function tree(root) {
  const rows = [];
  const walk = async (directory, prefix = '') => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name, path = join(directory, entry.name);
      if (entry.isDirectory()) { rows.push([name, 'directory']); await walk(path, name); }
      else rows.push([name, createHash('sha256').update(await readFile(path)).digest('hex')]);
    }
  };
  await walk(root); return rows.sort(([a], [b]) => a.localeCompare(b));
}

test('final inventory is read-only, accepts the real copy journal and requires later target SHA verification', async t => {
  const f = await fixture(t), before = await tree(f.root), progress = []; let offline = 0;
  const report = await verifyProductionStorageFinalInventory(f.source, f.target, { ...f.options,
    assertOffline: async () => { offline += 1; }, onProgress: value => progress.push(value) });
  assert.equal(report.files, 3); assert.equal(report.bytes, f.manifest.totalBytes);
  assert.equal(report.sourceUnchangedSinceCopy, true); assert.equal(report.targetInventoryMatchesSource, true);
  assert.equal(report.targetSha256Verified, false); assert.equal(report.requiresTargetSha256Verification, true);
  assert.deepEqual(report.excludedDirectories, ['.delivery-exports', '.task-archives', '.task-deletion-quarantine']);
  assert.equal(offline, 2); assert.deepEqual(await tree(f.root), before);
  assert.deepEqual([...new Set(progress.map(value => value.phase))], ['source-inventory', 'target-inventory', 'source-recheck']);
  assert.equal(progress.at(-1).scannedFiles, 3);
});

test('incomplete manifests and missing source fingerprints are rejected before scanning', async t => {
  for (const mode of ['digest', 'unverified', 'missing-directories', 'extra-directories', 'fingerprint', 'fingerprint-bytes']) await t.test(mode, async child => {
    const f = await fixture(child);
    if (mode === 'digest') f.manifest.totalBytes += 1;
    if (mode === 'unverified') { f.manifest.verified = false; seal(f.manifest); }
    if (mode === 'missing-directories') { f.manifest.missingDirectories = ['empty']; seal(f.manifest); }
    if (mode === 'extra-directories') { delete f.manifest.extraDirectories; seal(f.manifest); }
    if (mode === 'fingerprint') { delete f.manifest.files[0].source.ctimeMs; seal(f.manifest); }
    if (mode === 'fingerprint-bytes') { f.manifest.files[0].source.bytes += 1; seal(f.manifest); }
    await assert.rejects(verifyProductionStorageFinalInventory(f.source, f.target, { ...f.options,
      onProgress: () => assert.fail('invalid journals must fail before scanning') }));
  });
});

test('every source fingerprint field must equal the verified journal exactly', async t => {
  for (const field of ['bytes', 'mtimeMs', 'ctimeMs', 'ino', 'dev']) await t.test(field, async child => {
    const f = await fixture(child);
    // Windows file IDs can exceed integer precision in the copy journal's
    // numeric stat representation, so +1 need not change an inode number.
    f.manifest.files[0].source[field] = f.manifest.files[0].source[field] === 0 ? 1 : 0; seal(f.manifest);
    await assert.rejects(verifyProductionStorageFinalInventory(f.source, f.target, f.options), /fingerprint/u);
  });
});

test('source additions, deletions and same-size changes require another complete copy', async t => {
  for (const mode of ['add', 'remove', 'same-size', 'same-size-restored-mtime', 'replace-file']) await t.test(mode, async child => {
    const f = await fixture(child), original = await lstat(f.image);
    if (mode === 'add') await writeFile(join(f.source, 'new-file.txt'), 'new');
    if (mode === 'remove') await rm(f.image);
    if (mode === 'same-size' || mode === 'same-size-restored-mtime') {
      await delay(10); await writeFile(f.image, Buffer.alloc(original.size, 120));
      if (mode === 'same-size-restored-mtime') await utimes(f.image, original.atime, original.mtime);
    }
    if (mode === 'replace-file') {
      const replacement = join(f.source, 'replacement.tmp');
      await writeFile(replacement, await readFile(f.image));
      await utimes(replacement, original.atime, original.mtime); await rename(replacement, f.image);
    }
    await assert.rejects(verifyProductionStorageFinalInventory(f.source, f.target, f.options), /Source file (?:inventory|fingerprint) changed/u);
  });
});

test('target files and all source empty directories must have matching inventories', async t => {
  for (const mode of ['missing-file', 'extra-file', 'size', 'missing-target-empty', 'extra-target-empty', 'new-source-empty', 'removed-source-empty']) await t.test(mode, async child => {
    const f = await fixture(child), targetImage = join(f.target, 'tasks', '1', 'original.png');
    if (mode === 'missing-file') await rm(targetImage);
    if (mode === 'extra-file') await writeFile(join(f.target, 'extra.txt'), 'extra');
    if (mode === 'size') await writeFile(targetImage, 'changed size');
    if (mode === 'missing-target-empty') await removeWithin(f.root, join(f.target, 'empty'));
    if (mode === 'extra-target-empty') await mkdir(join(f.target, 'unexpected-empty'));
    if (mode === 'new-source-empty') await mkdir(join(f.source, 'new-empty'));
    if (mode === 'removed-source-empty') await removeWithin(f.root, join(f.source, 'empty'));
    await assert.rejects(verifyProductionStorageFinalInventory(f.source, f.target, f.options), /(?:inventory|inventories|size) differ/u);
  });
});

test('same-size target corruption deliberately passes metadata-only review and is not reported as SHA verified', async t => {
  const f = await fixture(t), targetImage = join(f.target, 'tasks', '1', 'original.png');
  const bytes = await readFile(targetImage); await writeFile(targetImage, Buffer.alloc(bytes.length, 120));
  assert.notDeepEqual(await readFile(targetImage), bytes);
  const report = await verifyProductionStorageFinalInventory(f.source, f.target, f.options);
  assert.equal(report.targetSha256Verified, false); assert.equal(report.requiresTargetSha256Verification, true);
});

test('source changes while target metadata is enumerated are caught by the final source pass', async t => {
  for (const mode of ['file', 'directory']) await t.test(mode, async child => {
    const f = await fixture(child); let changed = false;
    await assert.rejects(verifyProductionStorageFinalInventory(f.source, f.target, { ...f.options, onProgress: async value => {
      if (!changed && value.phase === 'target-inventory') {
        changed = true;
        if (mode === 'file') await writeFile(join(f.source, 'new-file.txt'), 'new');
        else await mkdir(join(f.source, 'new-empty'));
      }
    } }), /Source (?:file|directory) inventory changed/u);
    assert.equal(changed, true);
  });
});

test('all links are refused, including root ancestors, nested paths, markers and excluded temporary trees', async t => {
  for (const mode of ['source-root', 'target-root', 'target-ancestor', 'nested-source', 'nested-target', 'excluded', 'owner']) await t.test(mode, async child => {
    const f = await fixture(child), kind = process.platform === 'win32' ? 'junction' : 'dir';
    let source = f.source, target = f.target;
    if (mode === 'source-root') {
      const physical = join(f.root, 'physical-source'); await rename(source, physical); await symlink(physical, source, kind);
    } else if (mode === 'target-root') {
      const physical = join(f.root, 'physical-target'); await rename(target, physical); await symlink(physical, target, kind);
    } else if (mode === 'target-ancestor') {
      const physical = join(f.root, 'physical'), alias = join(f.root, 'alias');
      await mkdir(physical); await rename(target, join(physical, 'target')); await symlink(physical, alias, kind);
      target = join(alias, 'target'); f.manifest.targetRoot = target; seal(f.manifest);
    } else if (mode === 'nested-source' || mode === 'nested-target') {
      const base = mode === 'nested-source' ? source : target;
      const physical = join(f.root, 'physical-tasks'); await rename(join(base, 'tasks'), physical); await symlink(physical, join(base, 'tasks'), kind);
    } else if (mode === 'excluded') await symlink(target, join(source, '.delivery-exports', 'linked'), kind);
    else { await rm(join(target, 'migration-owner.json')); await symlink(source, join(target, 'migration-owner.json'), kind); }
    await assert.rejects(verifyProductionStorageFinalInventory(source, target, f.options), /links/u);
  });
});

test('temporary exclusions and a normal owner lock are allowed, but pending deletion quarantine refuses cutover', async t => {
  const f = await fixture(t);
  await writeFile(join(f.target, 'migration-owner.json.publish.lock'), 'fixture lock');
  await writeFile(join(f.source, '.delivery-exports', 'new-temporary.zip'), 'disposable');
  await writeFile(join(f.source, '.task-archives', 'new-temporary.zip'), 'disposable');
  await verifyProductionStorageFinalInventory(f.source, f.target, f.options);
  const pending = join(f.source, '.task-deletion-quarantine', 'pending'); await mkdir(pending);
  await writeFile(join(pending, 'retained.png'), 'uncommitted deletion');
  await assert.rejects(verifyProductionStorageFinalInventory(f.source, f.target, f.options), /Uncommitted task deletion quarantine/u);
});

test('offline checks and cancellation reject without mutating source or destination', async t => {
  for (const mode of ['initial-online', 'restarted', 'cancelled']) await t.test(mode, async child => {
    const f = await fixture(child), before = await tree(f.root); let offline = 0;
    const options = { ...f.options, assertOffline: async () => {
      offline += 1;
      if (mode === 'initial-online' || mode === 'restarted' && offline === 2) throw new Error('fixture production online');
    } };
    if (mode === 'cancelled') options.signal = AbortSignal.abort(new Error('fixture cancelled'));
    await assert.rejects(verifyProductionStorageFinalInventory(f.source, f.target, options), /fixture/u);
    assert.deepEqual(await tree(f.root), before);
  });
});
