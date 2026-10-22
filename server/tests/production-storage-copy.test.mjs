import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { copyProductionStorage } from '../../scripts/production-storage-copy.mjs';

const require = createRequire(import.meta.url), mutableFs = require('node:fs/promises');
const hash = value => createHash('sha256').update(value).digest('hex');
const exists = path => fs.access(path).then(() => true, () => false);
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhN0AAAAASUVORK5CYII=', 'base64');
const frozenJson = Buffer.from('{ "version": 1,\r\n "frozen": "历史快照字节" }\r\n');

async function write(path, contents) { await fs.mkdir(dirname(path), { recursive: true }); await fs.writeFile(path, contents); }

async function fixture(t, { files = null } = {}) {
  const temporary = await fs.mkdtemp(join(tmpdir(), 'xhs-storage-copy-test-')), root = await fs.realpath(temporary);
  t.after(async () => {
    assert.ok(temporary.startsWith(join(tmpdir(), 'xhs-storage-copy-test-')));
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const source = join(root, 'source'), target = join(root, 'destination'), reportPath = join(root, 'reports', 'copy.json');
  const original = files ?? { 'tasks/1/image-runs/run/01.png': image, 'attachments/input.bin': Buffer.from([0, 255, 1, 15]), '.delivery-snapshots/frozen.json': frozenJson };
  await fs.mkdir(source);
  for (const [path, bytes] of Object.entries(original)) await write(join(source, ...path.split('/')), bytes);
  return { root, source, target, reportPath, original };
}

function validateReport(report) {
  const { manifestSha256, ...manifest } = report;
  assert.equal(manifestSha256, hash(JSON.stringify(manifest)));
  assert.equal(report.format, 'xhs-production-storage-copy-journal');
  assert.equal(report.version, 1);
  if (report.verified) {
    assert.equal(report.phase, 'complete');
    assert.equal(report.totalFiles, report.files.length);
    assert.equal(report.processed, report.totalFiles);
    assert.equal(report.totalBytes, report.files.reduce((sum, file) => sum + file.bytes, 0));
    assert.deepEqual(report.failures, []);
    assert.deepEqual(report.missingFiles, []);
    assert.deepEqual(report.extraFiles, []);
  }
}

async function listFiles(root, prefix = '') {
  if (!(await exists(root))) return [];
  const files = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(join(root, entry.name), name));
    else files.push(name);
  }
  return files.sort();
}

test('dry run inventories all durable files without creating a target or journal directory', async t => {
  const data = await fixture(t), progress = [];
  const report = await copyProductionStorage(data.source, data.target, { reportPath: data.reportPath, onProgress: value => progress.push(value) });
  validateReport(report);
  assert.equal(report.verified, false);
  assert.equal(report.totalFiles, 3);
  assert.equal(report.planned, 3);
  assert.equal(report.copied, 0);
  assert.equal(await exists(data.target), false);
  assert.equal(await exists(dirname(data.reportPath)), false);
  assert.equal(progress[0].phase, 'inventory');
});

test('copy verifies originals and preserves attachment and snapshot JSON bytes exactly', async t => {
  const data = await fixture(t);
  const report = await copyProductionStorage(data.source, data.target, { apply: true, reportPath: data.reportPath });
  validateReport(report);
  assert.equal(report.verified, true);
  assert.equal(report.copied, 3);
  assert.equal(report.planned, 0);
  assert.equal(report.sourceRoot, data.source);
  assert.equal(report.targetRoot, data.target);
  assert.deepEqual(JSON.parse(await fs.readFile(data.reportPath, 'utf8')), report, 'returned report is the persisted verified journal');
  for (const file of report.files) {
    const original = data.original[file.path], destination = join(data.target, ...file.path.split('/'));
    assert.deepEqual(await fs.readFile(destination), original);
    assert.equal(file.sha256, hash(original));
    assert.equal(file.bytes, original.length);
    assert.deepEqual(await fs.readFile(join(data.source, ...file.path.split('/'))), original, 'source is untouched');
  }
  assert.deepEqual(await listFiles(data.target), [...Object.keys(data.original), 'migration-owner.json'].sort());
});

test('only the three temporary directories confirmed by the server are excluded', async t => {
  const data = await fixture(t);
  for (const name of ['.delivery-exports', '.task-archives']) await write(join(data.source, name, 'temporary.zip'), 'temporary');
  await write(join(data.source, '.task-deletion-quarantine', '1-committed', 'COMMITTED'), '2026-10-22T00:00:00.000Z');
  await write(join(data.source, '.task-deletion-quarantine', '1-committed', 'task', 'deleted.png'), image);
  await write(join(data.source, '.task-delete-quarantine', 'durable.bin'), 'not the actual server temporary directory');
  const report = await copyProductionStorage(data.source, data.target, { apply: true, reportPath: data.reportPath });
  validateReport(report);
  assert.equal(report.verified, true);
  assert.deepEqual(report.excludedDirectories.sort(), ['.delivery-exports', '.task-archives', '.task-deletion-quarantine'].sort());
  for (const excluded of report.excludedDirectories) assert.equal(await exists(join(data.target, excluded)), false);
  assert.equal(await fs.readFile(join(data.target, '.task-delete-quarantine', 'durable.bin'), 'utf8'), 'not the actual server temporary directory');
});

test('resuming reuses verified target bytes and dry-run verification does not rewrite the journal', async t => {
  const data = await fixture(t), options = { apply: true, reportPath: data.reportPath };
  const first = await copyProductionStorage(data.source, data.target, options);
  const originalJournal = await fs.readFile(data.reportPath);
  const dry = await copyProductionStorage(data.source, data.target, { reportPath: data.reportPath });
  validateReport(dry);
  assert.equal(dry.verified, true);
  assert.equal(dry.reused, 3);
  assert.deepEqual(await fs.readFile(data.reportPath), originalJournal);
  const resumed = await copyProductionStorage(data.source, data.target, options);
  validateReport(resumed);
  assert.equal(resumed.verified, true);
  assert.equal(resumed.copied, 0);
  assert.equal(resumed.reused, 3);
  assert.equal(resumed.migrationId, first.migrationId);
});

test('incremental copy replaces only journal-owned files whose old target hash still matches', async t => {
  const data = await fixture(t), options = { apply: true, reportPath: data.reportPath };
  await copyProductionStorage(data.source, data.target, options);
  const path = 'tasks/1/image-runs/run/01.png', replacement = Buffer.concat([image, Buffer.from('changed source')]);
  await write(join(data.source, ...path.split('/')), replacement);
  const report = await copyProductionStorage(data.source, data.target, options);
  validateReport(report);
  assert.equal(report.verified, true);
  assert.equal(report.copied, 1);
  assert.equal(report.reused, 2);
  assert.equal(report.files.find(file => file.path === path).sha256, hash(replacement));
  assert.deepEqual(await fs.readFile(join(data.target, ...path.split('/'))), replacement);
});

test('unknown nonempty targets and a mismatched migration owner are refused without overwriting files', async t => {
  const data = await fixture(t);
  await write(join(data.target, 'user-file.bin'), 'user bytes');
  await assert.rejects(copyProductionStorage(data.source, data.target, { apply: true, reportPath: data.reportPath }), /unknown nonempty/u);
  assert.equal(await fs.readFile(join(data.target, 'user-file.bin'), 'utf8'), 'user bytes');
  assert.equal(await exists(data.reportPath), false);
  await fs.rm(join(data.target, 'user-file.bin'));
  await copyProductionStorage(data.source, data.target, { apply: true, reportPath: data.reportPath });
  const different = join(data.root, 'different-source');
  await fs.mkdir(different);
  await assert.rejects(copyProductionStorage(different, data.target, { apply: true, reportPath: data.reportPath }), /owner does not match/u);
});

test('tampered existing targets and extra files are reported and never overwritten or deleted', async t => {
  const data = await fixture(t), options = { apply: true, reportPath: data.reportPath };
  await copyProductionStorage(data.source, data.target, options);
  const collision = join(data.target, 'attachments', 'input.bin'), changed = Buffer.from([9, 9, 9, 9]);
  await fs.writeFile(collision, changed);
  const extra = join(data.target, 'unmanaged.bin');
  await fs.writeFile(extra, 'retain this file');
  const report = await copyProductionStorage(data.source, data.target, options);
  validateReport(report);
  assert.equal(report.verified, false);
  assert.match(report.failures[0].error, /unknown or externally changed/u);
  assert.deepEqual(await fs.readFile(collision), changed);
  assert.equal(await fs.readFile(extra, 'utf8'), 'retain this file');
  assert.deepEqual(report.extraFiles, [{ path: 'unmanaged.bin', bytes: 'retain this file'.length }]);
});

test('source mutation after inventory fails safely and a later stable resume succeeds', async t => {
  const data = await fixture(t);
  let changed = false;
  const report = await copyProductionStorage(data.source, data.target, { apply: true, reportPath: data.reportPath,
    onProgress: async progress => {
      if (!changed && progress.phase === 'copying') { changed = true; await fs.writeFile(join(data.source, 'attachments', 'input.bin'), 'new bytes after inventory'); }
    } });
  validateReport(report);
  assert.equal(report.verified, false);
  assert.ok(report.failures.some(failure => /Source changed/u.test(failure.error)));
  assert.equal(await exists(join(data.target, 'attachments', 'input.bin')), false);
  const resumed = await copyProductionStorage(data.source, data.target, { apply: true, reportPath: data.reportPath });
  validateReport(resumed);
  assert.equal(resumed.verified, true);
});

test('source deletion leaves previous target files as explicit extras rather than deleting them', async t => {
  const data = await fixture(t), options = { apply: true, reportPath: data.reportPath };
  await copyProductionStorage(data.source, data.target, options);
  await fs.rm(join(data.source, 'attachments', 'input.bin'));
  const report = await copyProductionStorage(data.source, data.target, options);
  assert.equal(report.verified, false);
  assert.deepEqual(report.extraFiles, [{ path: 'attachments/input.bin', bytes: 4 }]);
  assert.equal(await exists(join(data.target, 'attachments', 'input.bin')), true);
  await fs.rm(join(data.target, 'attachments', 'input.bin'));
  const resumed = await copyProductionStorage(data.source, data.target, options);
  validateReport(resumed);
  assert.equal(resumed.verified, true);
  assert.equal(resumed.files.length, 2);
});

test('copy operations honor the configured limit of four concurrent native copies', async t => {
  const files = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`images/${index}.png`, image]));
  const data = await fixture(t, { files });
  const originalCopy = mutableFs.copyFile;
  let active = 0, maximum = 0;
  const mock = t.mock.method(mutableFs, 'copyFile', async (...args) => {
    active += 1; maximum = Math.max(maximum, active);
    try { await new Promise(resolve => setTimeout(resolve, 10)); return await originalCopy(...args); }
    finally { active -= 1; }
  });
  syncBuiltinESMExports();
  try {
    const report = await copyProductionStorage(data.source, data.target, { apply: true, reportPath: data.reportPath, concurrency: 4 });
    validateReport(report);
    assert.equal(report.verified, true);
    assert.ok(maximum > 1 && maximum <= 4, `maximum concurrent copies was ${maximum}`);
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
  await assert.rejects(copyProductionStorage(data.source, data.target, { concurrency: 5, reportPath: data.reportPath }), /between 1 and 4/u);
});

test('cancelling a copy cleans its temporary files, journals progress, and permits a verified resume', async t => {
  const files = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`images/${index}.png`, image]));
  const data = await fixture(t, { files }), controller = new AbortController(), originalCopy = mutableFs.copyFile;
  const mock = t.mock.method(mutableFs, 'copyFile', async (...args) => {
    await originalCopy(...args); controller.abort(new Error('copy cancelled'));
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(copyProductionStorage(data.source, data.target, { apply: true, reportPath: data.reportPath, signal: controller.signal }), /copy cancelled/u);
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
  assert.ok((await listFiles(data.target)).every(path => !/\.tmp$|\.publish\.lock$/u.test(path)));
  const journal = JSON.parse(await fs.readFile(data.reportPath, 'utf8'));
  validateReport(journal);
  assert.equal(journal.phase, 'cancelled');
  assert.equal(journal.verified, false);
  const resumed = await copyProductionStorage(data.source, data.target, { apply: true, reportPath: data.reportPath });
  validateReport(resumed);
  assert.equal(resumed.verified, true);
  assert.equal(resumed.files.length, 8);
});

test('source and target containment, linked ancestors, and linked source entries are rejected', async t => {
  const data = await fixture(t);
  await assert.rejects(copyProductionStorage(data.source, join(data.source, 'nested'), { apply: true, reportPath: data.reportPath }), /cannot contain/u);
  await assert.rejects(copyProductionStorage(data.source, data.root, { apply: true, reportPath: data.reportPath }), /cannot contain/u);
  const outside = join(data.root, 'outside'), linked = join(data.root, 'linked');
  await fs.mkdir(outside);
  try { await fs.symlink(outside, linked, 'junction'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('junctions unavailable'); return; } throw error; }
  await assert.rejects(copyProductionStorage(data.source, join(linked, 'destination'), { apply: true, reportPath: data.reportPath }), /ancestors must not be links/u);
  await fs.symlink(outside, join(data.source, 'linked-input'), 'junction');
  await assert.rejects(copyProductionStorage(data.source, data.target, { apply: true, reportPath: data.reportPath }), /must not be links/u);
  assert.deepEqual(await fs.readdir(outside), []);
  assert.equal(await exists(data.target), false);
});

test('a modified journal cannot authorize replacement or target ownership', async t => {
  const data = await fixture(t), options = { apply: true, reportPath: data.reportPath };
  await copyProductionStorage(data.source, data.target, options);
  const journal = JSON.parse(await fs.readFile(data.reportPath, 'utf8'));
  journal.files[0].sha256 = '0'.repeat(64);
  await fs.writeFile(data.reportPath, JSON.stringify(journal));
  await assert.rejects(copyProductionStorage(data.source, data.target, options), /journal is invalid/u);
});

test('an out-of-date owned destination is planned for update and cannot pass dry-run verification', async t => {
  const data = await fixture(t), options = { apply: true, reportPath: data.reportPath };
  await copyProductionStorage(data.source, data.target, options);
  await fs.writeFile(join(data.source, 'attachments', 'input.bin'), 'source has a new version');
  const report = await copyProductionStorage(data.source, data.target, { reportPath: data.reportPath });
  validateReport(report);
  assert.equal(report.verified, false);
  assert.equal(report.phase, 'planned');
  assert.equal(report.planned, 1);
  assert.deepEqual(await fs.readFile(join(data.target, 'attachments', 'input.bin')), data.original['attachments/input.bin']);
});

test('empty storage directories are copied and missing directories cannot be marked verified', async t => {
  const data = await fixture(t);
  await fs.mkdir(join(data.source, 'empty-directory', 'nested'), { recursive: true });
  const report = await copyProductionStorage(data.source, data.target, { apply: true, reportPath: data.reportPath });
  validateReport(report);
  assert.equal(report.verified, true);
  assert.equal((await fs.lstat(join(data.target, 'empty-directory', 'nested'))).isDirectory(), true);
  await fs.rm(join(data.target, 'empty-directory'), { recursive: true });
  const dry = await copyProductionStorage(data.source, data.target, { reportPath: data.reportPath });
  assert.equal(dry.verified, false);
  assert.ok(dry.missingDirectories.includes('empty-directory/nested'));
});

test('uncommitted deletion quarantine blocks copying so recoverable original images are never silently omitted', async t => {
  const data = await fixture(t);
  await write(join(data.source, '.task-deletion-quarantine', '1-uncommitted', 'task', 'recoverable.png'), image);
  await assert.rejects(copyProductionStorage(data.source, data.target, { apply: true, reportPath: data.reportPath }), /Uncommitted task deletion quarantine/u);
  assert.equal(await exists(data.target), false);
  assert.deepEqual(await fs.readFile(join(data.source, '.task-deletion-quarantine', '1-uncommitted', 'task', 'recoverable.png')), image);
});
