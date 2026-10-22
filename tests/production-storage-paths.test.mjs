import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { copyProductionStorage } from '../scripts/production-storage-copy.mjs';
import { assertStorageServiceStopped, migrateProductionStoragePaths, validateStorageCopyManifest } from '../scripts/production-storage-paths.mjs';

const tables = ['assets', 'delivery_snapshot_assets', 'knowledge_versions', 'image_reference_cleanup_jobs', 'task_reassignment_cleanup'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function seal(manifest) {
  const { manifestSha256, ...contents } = manifest;
  manifest.manifestSha256 = hash(JSON.stringify(contents));
  return manifest;
}
function matches(path, root) {
  return path.toLowerCase().startsWith(root.toLowerCase()) && ['', '/', '\\'].includes(path.slice(root.length, root.length + 1));
}

class FakeDatabase {
  constructor(rows, options = {}) {
    this.rows = structuredClone(rows); this.options = options; this.calls = [];
    this.database = 'xhs_control_prod'; this.active = 0; this.transaction = null;
  }
  async query(sql, parameters = []) {
    const text = sql.replace(/\s+/gu, ' ').trim();
    this.calls.push({ sql: text, parameters });
    if (text.startsWith('BEGIN')) {
      assert.equal(this.transaction, null);
      this.transaction = structuredClone(this.rows); this.readOnly = text.includes('READ ONLY');
      return { rows: [] };
    }
    if (text === 'ROLLBACK') { this.transaction = null; return { rows: [] }; }
    if (text === 'COMMIT') {
      if (this.options.failCommit) {
        if (this.options.commitBeforeDisconnect) { this.rows = this.transaction; this.transaction = null; }
        const error = new Error('simulated commit failure'); error.code = this.options.commitCode ?? '40001'; throw error;
      }
      this.rows = this.transaction; this.transaction = null; return { rows: [] };
    }
    assert.ok(this.transaction, 'all database access stays inside the transaction');
    if (text === 'SELECT current_database() AS name') return { rows: [{ name: this.database }] };
    if (text.startsWith('LOCK TABLE')) { assert.equal(this.readOnly, false); return { rows: [] }; }
    if (text.includes('FROM task_executions')) return { rows: [{ total: String(this.active) }] };
    const count = /^SELECT count\(\*\) AS total FROM (\w+) WHERE /u.exec(text);
    if (count) return { rows: [{ total: String(this.transaction[count[1]].filter(row => matches(row.storage_path, parameters[0])).length) }] };
    const normalized = /^SELECT count\(\*\) AS normalized_total FROM (\w+) WHERE /u.exec(text);
    if (normalized) return { rows: [{ normalized_total: String(this.transaction[normalized[1]].filter(row => matches(row.storage_path.replaceAll('\\', '/'), parameters[0].replaceAll('\\', '/'))).length) }] };
    const select = /^SELECT (?:id,|snapshot_public_id,).+ FROM (\w+) WHERE /u.exec(text);
    if (select) return { rows: structuredClone(this.transaction[select[1]].filter(row => matches(row.storage_path, parameters[0]))) };
    const update = /^UPDATE (\w+) SET storage_path=/u.exec(text);
    if (update) {
      assert.equal(this.readOnly, false);
      if (this.options.failUpdate === update[1]) throw new Error('simulated update failure');
      let rowCount = 0;
      for (const row of this.transaction[update[1]]) if (matches(row.storage_path, parameters[0])) {
        row.storage_path = parameters[1] + row.storage_path.slice(parameters[0].length); rowCount += 1;
      }
      return { rows: [], rowCount: rowCount + (this.options.wrongCount === update[1] ? 1 : 0) };
    }
    throw new Error(`Unexpected fake query: ${text}`);
  }
  writes() { return this.calls.filter(call => call.sql.startsWith('UPDATE')); }
}

async function removeFixturePath(root, path) {
  const suffix = relative(resolve(root), resolve(path));
  assert.ok(suffix && !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`));
  await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
}

async function fixture(t, options = {}) {
  const temporary = await mkdtemp(join(tmpdir(), 'xhs-storage-path-tests-')), root = await realpath(temporary);
  t.after(async () => {
    const suffix = relative(resolve(tmpdir()), resolve(temporary));
    assert.ok(suffix && !isAbsolute(suffix) && suffix.startsWith('xhs-storage-path-tests-') && !suffix.includes(sep));
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  });
  const sourceRoot = join(root, 'source'), targetRoot = join(root, 'target');
  const contents = new Map([
    ['tasks/1/original.png', Buffer.from('fixture-original-image')],
    ['.delivery-snapshots/frozen.json', Buffer.from('{"fixture":"frozen-relative-paths"}')],
    ['attachments/fixture.txt', Buffer.from('fixture attachment')],
  ]);
  for (const directory of [sourceRoot, targetRoot]) for (const [path, bytes] of contents) {
    const file = join(directory, ...path.split('/'));
    await mkdir(dirname(file), { recursive: true }); await writeFile(file, bytes);
  }
  const files = [...contents].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) }));
  const manifest = seal({ format: 'xhs-production-storage-copy-journal', version: 1, migrationId: randomUUID(),
    sourceRoot, targetRoot, verified: true, phase: 'complete', totalFiles: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0), processed: files.length, planned: 0,
    failures: [], missingFiles: [], extraFiles: [], files });
  const rows = Object.fromEntries(tables.map(table => [table, []]));
  rows.assets = [
    { id: 1, storage_path: join(sourceRoot, 'tasks', '1', 'original.png'), sha256: files[0].sha256, byte_size: files[0].bytes, content_cleared_at: null },
    { id: 2, storage_path: join(sourceRoot, 'tasks', '1', 'already-cleared.png'), sha256: 'a'.repeat(64), byte_size: 123, content_cleared_at: '2026-10-01T00:00:00Z' },
  ];
  rows.delivery_snapshot_assets = [{ snapshot_public_id: randomUUID(), storage_path: rows.assets[0].storage_path, sha256: files[0].sha256, byte_size: files[0].bytes }];
  const database = new FakeDatabase(rows, options);
  return { root, sourceRoot, targetRoot, manifest, database, contents,
    input: { sourceRoot, targetRoot, manifest, apply: true, assertOffline: async () => {} } };
}

test('preview uses a read-only transaction, needs no target or manifest, and never invokes environment/offline hooks', async t => {
  const f = await fixture(t), original = structuredClone(f.database.rows);
  await removeFixturePath(f.root, f.targetRoot);
  const result = await migrateProductionStoragePaths(f.database, { sourceRoot: f.sourceRoot, targetRoot: f.targetRoot,
    assertOffline: () => assert.fail('preview must not check/stop services'), beforeCommit: () => assert.fail('preview must not edit environment') });
  assert.equal(result.apply, false); assert.equal(result.counts.find(row => row.table === 'assets').rows, 2);
  assert.equal(f.database.calls[0].sql, 'BEGIN TRANSACTION READ ONLY');
  assert.equal(f.database.calls.at(-1).sql, 'COMMIT'); assert.equal(f.database.writes().length, 0);
  assert.deepEqual(f.database.rows, original);
});

test('a nonproduction database rolls back before any path changes', async t => {
  const f = await fixture(t); f.database.database = 'xhs_control';
  await assert.rejects(migrateProductionStoragePaths(f.database, f.input), /restricted to the production database/u);
  assert.equal(f.database.writes().length, 0); assert.equal(f.database.calls.at(-1).sql, 'ROLLBACK');
});

test('offline check refuses a live local test listener and accepts a closed ephemeral port', async () => {
  const server = createServer(socket => socket.end());
  await new Promise(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise));
  const port = server.address().port;
  try { await assert.rejects(assertStorageServiceStopped({ port }), /still listening/u); }
  finally { await new Promise(resolvePromise => server.close(resolvePromise)); }
  await assertStorageServiceStopped({ port });
});

test('offline and active-operation guards fail before mutations', async t => {
  await t.test('initial live service', async child => {
    const f = await fixture(child);
    await assert.rejects(migrateProductionStoragePaths(f.database, { ...f.input, assertOffline: async () => { throw new Error('live service'); } }), /live service/u);
    assert.equal(f.database.calls.length, 0);
  });
  await t.test('database work is active', async child => {
    const f = await fixture(child); f.database.active = 1;
    await assert.rejects(migrateProductionStoragePaths(f.database, f.input), /must be idle/u);
    assert.equal(f.database.writes().length, 0); assert.equal(f.database.calls.at(-1).sql, 'ROLLBACK');
  });
  await t.test('service restarted during verification', async child => {
    const f = await fixture(child), original = structuredClone(f.database.rows); let calls = 0;
    await assert.rejects(migrateProductionStoragePaths(f.database, { ...f.input,
      assertOffline: async () => { if (++calls === 2) throw new Error('service restarted'); },
      beforeCommit: () => assert.fail('must not update environment while online') }), /service restarted/u);
    assert.ok(f.database.writes().length > 0); assert.deepEqual(f.database.rows, original);
  });
});

test('apply requires a complete verified journal with consistent digest, counts, roots and file metadata', async t => {
  const cases = {
    absent: f => { f.input.manifest = undefined; },
    unverified: f => { f.manifest.verified = false; seal(f.manifest); },
    partial: f => { f.manifest.phase = 'copying'; seal(f.manifest); },
    wrongFormat: f => { f.manifest.format = 'another-format'; seal(f.manifest); },
    alteredDigest: f => { f.manifest.files.pop(); },
    truncatedCount: f => { f.manifest.files.pop(); seal(f.manifest); },
    unprocessed: f => { f.manifest.processed -= 1; seal(f.manifest); },
    planned: f => { f.manifest.planned = 1; seal(f.manifest); },
    wrongBytes: f => { f.manifest.totalBytes += 1; seal(f.manifest); },
    failedFiles: f => { f.manifest.failures = ['failure']; seal(f.manifest); },
    missingFiles: f => { f.manifest.missingFiles = ['missing']; seal(f.manifest); },
    extraFiles: f => { f.manifest.extraFiles = ['extra']; seal(f.manifest); },
    wrongSource: f => { f.manifest.sourceRoot += '-other'; seal(f.manifest); },
    wrongTarget: f => { f.manifest.targetRoot += '-other'; seal(f.manifest); },
    traversal: f => { f.manifest.files[0].path = '../escaped.png'; seal(f.manifest); },
    absolute: f => { f.manifest.files[0].path = '/absolute.png'; seal(f.manifest); },
    alternateStream: f => { f.manifest.files[0].path += ':other'; seal(f.manifest); },
    trailingDot: f => { f.manifest.files[0].path += '.'; seal(f.manifest); },
    controlCharacter: f => { f.manifest.files[0].path += '\u0000'; seal(f.manifest); },
    duplicateCase: f => { f.manifest.files[1] = { ...f.manifest.files[0], path: f.manifest.files[0].path.toUpperCase() }; seal(f.manifest); },
    invalidChecksum: f => { f.manifest.files[0].sha256 = 'wrong'; seal(f.manifest); },
  };
  for (const [name, mutate] of Object.entries(cases)) await t.test(name, async child => {
    const f = await fixture(child); mutate(f);
    await assert.rejects(migrateProductionStoragePaths(f.database, f.input));
    assert.equal(f.database.calls.length, 0);
  });
});

test('the actual copy module produces a journal accepted for path cutover', async t => {
  const f = await fixture(t);
  await removeFixturePath(f.root, f.targetRoot);
  const manifest = await copyProductionStorage(f.sourceRoot, f.targetRoot, { apply: true, reportPath: join(f.root, 'copy-journal.json') });
  assert.equal(validateStorageCopyManifest(manifest, f.sourceRoot, f.targetRoot).size, 3);
  const result = await migrateProductionStoragePaths(f.database, { ...f.input, manifest });
  assert.equal(result.verifiedFiles, 3);
});

test('root boundaries reject equal, nested and volume roots before querying', async t => {
  for (const shape of ['equal', 'target-child', 'source-child', 'volume']) await t.test(shape, async child => {
    const f = await fixture(child); const input = { sourceRoot: f.sourceRoot, targetRoot: f.targetRoot };
    if (shape === 'equal') input.targetRoot = input.sourceRoot;
    if (shape === 'target-child') input.targetRoot = join(input.sourceRoot, 'nested');
    if (shape === 'source-child') input.sourceRoot = join(input.targetRoot, 'nested');
    if (shape === 'volume') input.targetRoot = parse(input.targetRoot).root;
    await assert.rejects(migrateProductionStoragePaths(f.database, input));
    assert.equal(f.database.calls.length, 0);
  });
});

test('a similar prefix remains untouched while selected paths, including tombstones, migrate atomically and idempotently', async t => {
  const f = await fixture(t), unrelated = { ...f.database.rows.assets[0], id: 3, storage_path: join(`${f.sourceRoot}-other`, 'untouched.png') };
  f.database.rows.assets.push(unrelated);
  const before = structuredClone(f.database.rows), progress = []; let offline = 0, committedEnvironment = false;
  const input = { ...f.input, assertOffline: async () => { offline += 1; }, onProgress: value => progress.push(value),
    beforeCommit: async () => { committedEnvironment = true; return () => { committedEnvironment = false; }; } };
  const result = await migrateProductionStoragePaths(f.database, input);
  assert.equal(result.alreadyMigrated, false); assert.equal(result.verifiedOriginals, 1);
  assert.equal(result.frozenReferences, 1); assert.equal(result.verifiedFiles, 3);
  assert.equal(offline, 2); assert.equal(committedEnvironment, true);
  assert.equal(f.database.calls[0].sql, 'BEGIN ISOLATION LEVEL SERIALIZABLE');
  for (const table of tables) for (const [index, row] of f.database.rows[table].entries()) {
    const old = before[table][index];
    const path = matches(old.storage_path, f.sourceRoot) ? f.targetRoot + old.storage_path.slice(f.sourceRoot.length) : old.storage_path;
    assert.deepEqual(row, { ...old, storage_path: path }, 'only the exact root prefix changes');
  }
  assert.deepEqual(f.database.rows.assets[2], unrelated);
  assert.equal(progress[0].verifiedFiles, 0); assert.equal(progress.at(-1).verifiedFiles, 3);
  assert.equal(progress.at(-1).verifiedBytes, f.manifest.totalBytes);
  const writes = f.database.writes().length;
  const second = await migrateProductionStoragePaths(f.database, input);
  assert.equal(second.alreadyMigrated, true); assert.equal(f.database.writes().length, writes);
  assert.equal(second.frozenReferences, 1); assert.equal(committedEnvironment, true);
  for (const [path, bytes] of f.contents) assert.deepEqual(await readFile(join(f.sourceRoot, ...path.split('/'))), bytes);
});

test('partial cutovers spanning different tables are rejected', async t => {
  const f = await fixture(t);
  f.database.rows.delivery_snapshot_assets[0].storage_path = join(f.targetRoot, 'tasks', '1', 'original.png');
  await assert.rejects(migrateProductionStoragePaths(f.database, f.input), /Old and new paths coexist/u);
  assert.equal(f.database.writes().length, 0); assert.equal(f.database.calls.at(-1).sql, 'ROLLBACK');
});

test('separator variants in either old or new roots are refused instead of silently missed', async t => {
  for (const mode of ['old', 'new']) await t.test(mode, async child => {
    const f = await fixture(child), root = mode === 'old' ? f.sourceRoot : f.targetRoot;
    const variant = process.platform === 'win32' ? join(root, 'tasks', '1', 'original.png').replaceAll('\\', '/')
      : join(root, 'tasks', '1', 'original.png').replaceAll('/', '\\');
    f.database.rows.assets[0].storage_path = variant;
    await assert.rejects(migrateProductionStoragePaths(f.database, f.input), /separator variants/u);
    assert.equal(f.database.writes().length, 0); assert.equal(f.database.calls.at(-1).sql, 'ROLLBACK');
  });
});

test('invalid originals and frozen references fail before updates', async t => {
  for (const mode of ['missing-original', 'wrong-hash', 'wrong-size', 'escaped-path', 'missing-reference', 'cleared-but-referenced']) await t.test(mode, async child => {
    const f = await fixture(child);
    if (mode === 'missing-original') f.database.rows.assets[0].storage_path = join(f.sourceRoot, 'missing.png');
    if (mode === 'wrong-hash') f.database.rows.assets[0].sha256 = '0'.repeat(64);
    if (mode === 'wrong-size') f.database.rows.assets[0].byte_size += 1;
    if (mode === 'escaped-path') f.database.rows.assets[0].storage_path = `${f.sourceRoot}${sep}..${sep}escaped.png`;
    if (mode === 'missing-reference') f.database.rows.delivery_snapshot_assets[0].storage_path = join(f.sourceRoot, 'missing-reference.png');
    if (mode === 'cleared-but-referenced') f.database.rows.delivery_snapshot_assets[0] = { ...f.database.rows.assets[1], snapshot_public_id: randomUUID() };
    await assert.rejects(migrateProductionStoragePaths(f.database, f.input));
    assert.equal(f.database.writes().length, 0); assert.equal(f.database.calls.at(-1).sql, 'ROLLBACK');
  });
});

test('all copied targets, including snapshots and attachments, must exist with unchanged SHA256', async t => {
  for (const mode of ['missing-image', 'changed-size', 'same-size-corruption', 'missing-snapshot', 'corrupt-attachment']) await t.test(mode, async child => {
    const f = await fixture(child), imagePath = join(f.targetRoot, 'tasks', '1', 'original.png');
    if (mode === 'missing-image') await rm(imagePath);
    if (mode === 'changed-size') await writeFile(imagePath, 'wrong size');
    if (mode === 'same-size-corruption') await writeFile(imagePath, Buffer.alloc(f.manifest.files[0].bytes, 120));
    if (mode === 'missing-snapshot') await rm(join(f.targetRoot, '.delivery-snapshots', 'frozen.json'));
    if (mode === 'corrupt-attachment') await writeFile(join(f.targetRoot, 'attachments', 'fixture.txt'), Buffer.alloc(f.manifest.files[2].bytes, 120));
    await assert.rejects(migrateProductionStoragePaths(f.database, f.input));
    assert.equal(f.database.writes().length, 0); assert.equal(f.database.calls.at(-1).sql, 'ROLLBACK');
  });
});

test('target root, ancestor and nested directory links are rejected', async t => {
  for (const mode of ['root', 'ancestor', 'nested']) await t.test(mode, async child => {
    const f = await fixture(child);
    if (mode === 'root') {
      await removeFixturePath(f.root, f.targetRoot);
      await symlink(f.sourceRoot, f.targetRoot, process.platform === 'win32' ? 'junction' : 'dir');
    } else if (mode === 'nested') {
      await removeFixturePath(f.root, join(f.targetRoot, 'tasks'));
      await symlink(join(f.sourceRoot, 'tasks'), join(f.targetRoot, 'tasks'), process.platform === 'win32' ? 'junction' : 'dir');
    } else {
      const physical = join(f.root, 'physical'), alias = join(f.root, 'alias');
      await mkdir(physical); await rename(f.targetRoot, join(physical, 'target'));
      await symlink(physical, alias, process.platform === 'win32' ? 'junction' : 'dir');
      f.input.targetRoot = join(alias, 'target'); f.manifest.targetRoot = f.input.targetRoot; seal(f.manifest);
    }
    await assert.rejects(migrateProductionStoragePaths(f.database, f.input), /links/u);
    assert.equal(f.database.writes().length, 0);
  });
});

test('update errors, changed row counts and commit failures roll back every path change', async t => {
  for (const options of [{ failUpdate: 'delivery_snapshot_assets' }, { wrongCount: 'assets' }, { failCommit: true }]) await t.test(JSON.stringify(options), async child => {
    const f = await fixture(child, options), before = structuredClone(f.database.rows);
    await assert.rejects(migrateProductionStoragePaths(f.database, f.input));
    assert.deepEqual(f.database.rows, before); assert.equal(f.database.calls.at(-1).sql, 'ROLLBACK');
  });
});

test('a COMMIT failure invokes the environment undo returned by beforeCommit', async t => {
  const f = await fixture(t, { failCommit: true }), before = structuredClone(f.database.rows);
  let environment = 'old', undos = 0;
  await assert.rejects(migrateProductionStoragePaths(f.database, { ...f.input, beforeCommit: async () => {
    environment = 'new'; return async () => { environment = 'old'; undos += 1; };
  } }), /simulated commit failure/u);
  assert.equal(environment, 'old'); assert.equal(undos, 1); assert.deepEqual(f.database.rows, before);
});

test('an ambiguous COMMIT preserves the new environment whether or not the server committed', async t => {
  for (const commitBeforeDisconnect of [false, true]) await t.test(String(commitBeforeDisconnect), async child => {
    const f = await fixture(child, { failCommit: true, commitCode: 'ECONNRESET', commitBeforeDisconnect });
    const before = structuredClone(f.database.rows); let environment = 'old', undos = 0;
    await assert.rejects(migrateProductionStoragePaths(f.database, { ...f.input, beforeCommit: async () => {
      environment = 'new'; return async () => { environment = 'old'; undos += 1; };
    } }), error => error.code === 'STORAGE_CUTOVER_COMMIT_UNKNOWN' && /Keep production stopped/u.test(error.message));
    assert.equal(environment, 'new'); assert.equal(undos, 0);
    assert.equal(f.database.calls.at(-1).sql, 'COMMIT');
    if (commitBeforeDisconnect) assert.notDeepEqual(f.database.rows, before);
    else assert.deepEqual(f.database.rows, before);
  });
});

test('beforeCommit can restore its own partially failed environment write and the database then rolls back', async t => {
  const f = await fixture(t), before = structuredClone(f.database.rows); let environment = 'old';
  await assert.rejects(migrateProductionStoragePaths(f.database, { ...f.input, beforeCommit: async () => {
    environment = 'partial';
    try { throw new Error('simulated environment write failure'); }
    catch (error) { environment = 'old'; throw error; }
  } }), /environment write failure/u);
  assert.equal(environment, 'old'); assert.deepEqual(f.database.rows, before);
  assert.equal(f.database.calls.at(-1).sql, 'ROLLBACK');
});

test('progress callback failure aborts verification without any committed mutation', async t => {
  const f = await fixture(t), before = structuredClone(f.database.rows);
  await assert.rejects(migrateProductionStoragePaths(f.database, { ...f.input, onProgress: async progress => {
    if (progress.verifiedFiles) throw new Error('verification observer cancelled');
  } }), /observer cancelled/u);
  assert.deepEqual(f.database.rows, before); assert.equal(f.database.writes().length, 0);
});
