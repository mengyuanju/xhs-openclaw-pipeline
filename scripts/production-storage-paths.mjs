import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { createConnection } from 'node:net';
import { connectDatabase, isMain, loadConfiguration, safeError } from '../server/scripts/database-common.mjs';

const PATH_TABLES = Object.freeze([
  'assets', 'delivery_snapshot_assets', 'knowledge_versions',
  'image_reference_cleanup_jobs', 'task_reassignment_cleanup',
]);
const pathPredicate = `left(lower(storage_path),length($1))=lower($1)
  AND substring(storage_path FROM length($1)+1 FOR 1) IN ('', chr(92), '/')`;
const normalizedPathPredicate = `left(lower(replace(storage_path,chr(92),'/')),length($1))=lower(replace($1,chr(92),'/'))
  AND substring(replace(storage_path,chr(92),'/') FROM length($1)+1 FOR 1) IN ('', '/')`;

async function countPaths(client, table, root) {
  const count = Number((await client.query(`SELECT count(*) AS total FROM ${table} WHERE ${pathPredicate}`, [root])).rows[0].total);
  const normalized = Number((await client.query(`SELECT count(*) AS normalized_total FROM ${table} WHERE ${normalizedPathPredicate}`, [root])).rows[0].normalized_total);
  assert.equal(count, normalized, 'Path separator variants would be missed; normalize them explicitly before migrating');
  return count;
}

function definiteCommitRejection(error) {
  // A transport error cannot tell whether PostgreSQL committed before the
  // connection was lost. Only explicit server rejections prove no commit.
  return typeof error?.code === 'string'
    && (/^(?:23|25)[0-9A-Z]{3}$/u.test(error.code) || ['40001', '40P01'].includes(error.code));
}

function canonicalPrefix(path) {
  assert.ok(typeof path === 'string' && isAbsolute(path), 'Storage roots must be absolute');
  const root = resolve(path);
  assert.ok(relative(resolve(root, '..'), root), 'Storage root cannot be a volume root');
  return root;
}

function relativeAsset(root, path) {
  const suffix = relative(root, resolve(path));
  assert.ok(suffix && !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`), 'Asset path escaped storage root');
  return suffix.replaceAll('\\', '/');
}

export function validateStorageCopyManifest(manifest, sourceRoot, targetRoot) {
  assert.ok(manifest?.format === 'xhs-production-storage-copy-journal' && manifest.version === 1
    && manifest.verified === true && manifest.phase === 'complete' && Array.isArray(manifest.files), 'A complete verified storage copy is required');
  assert.ok(typeof manifest.sourceRoot === 'string' && isAbsolute(manifest.sourceRoot)
    && typeof manifest.targetRoot === 'string' && isAbsolute(manifest.targetRoot), 'Manifest roots must be absolute');
  assert.equal(resolve(manifest.sourceRoot).toLowerCase(), resolve(sourceRoot).toLowerCase(), 'Manifest source differs');
  assert.equal(resolve(manifest.targetRoot).toLowerCase(), resolve(targetRoot).toLowerCase(), 'Manifest target differs');
  assert.ok(['failures', 'missingFiles', 'extraFiles'].every(key => Array.isArray(manifest[key]) && manifest[key].length === 0), 'Storage copy has incomplete or failed files');
  assert.ok(Number.isSafeInteger(manifest.totalFiles) && manifest.totalFiles === manifest.files.length
    && manifest.processed === manifest.totalFiles && manifest.planned === 0, 'Storage copy file counts are incomplete');
  const { manifestSha256, ...contents } = manifest;
  assert.equal(createHash('sha256').update(JSON.stringify(contents)).digest('hex'), manifestSha256, 'Storage copy manifest checksum differs');
  const files = new Map();
  let bytes = 0;
  for (const file of manifest.files) {
    assert.ok(typeof file.path === 'string', 'Invalid verified file path');
    const path = file.path.replaceAll('\\', '/');
    assert.ok(path && !/[\u0000-\u001f\u007f:]/u.test(path)
      && path.split('/').every(part => part && part !== '.' && part !== '..' && !/[ .]$/u.test(part)), 'Invalid verified file path');
    assert.ok(Number.isSafeInteger(file.bytes) && file.bytes >= 0 && /^[a-f0-9]{64}$/u.test(file.sha256), 'Invalid verified file checksum');
    const key = path.normalize('NFC').toLowerCase();
    assert.ok(!files.has(key), 'Duplicate verified file path');
    files.set(key, { ...file, path });
    bytes += file.bytes;
  }
  assert.ok(Number.isSafeInteger(bytes) && manifest.totalBytes === bytes, 'Storage copy byte count differs');
  return files;
}

export async function assertStorageServiceStopped({ host = '127.0.0.1', port = 4310 } = {}) {
  await new Promise((done, fail) => {
    const connection = createConnection({ host, port });
    connection.setTimeout(3000);
    connection.once('connect', () => {
      connection.destroy(); fail(new Error('Production service is still listening; stop the center and its worker before switching storage'));
    });
    connection.once('error', error => {
      connection.destroy();
      if (error.code === 'ECONNREFUSED') done();
      else fail(error);
    });
    connection.once('timeout', () => { connection.destroy(); fail(new Error('Cannot prove the production service is stopped')); });
  });
}

async function assertTargetRoot(targetRoot) {
  const volume = parse(targetRoot).root;
  let current = volume;
  for (const component of ['', ...relative(volume, targetRoot).split(sep).filter(Boolean)]) {
    current = component ? join(current, component) : current;
    const metadata = await lstat(current);
    assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink(), 'Target storage ancestors must be real directories without links');
  }
}

async function assertTargetFile(targetRoot, path, expected) {
  const target = resolve(targetRoot, ...path.split('/'));
  assert.equal(relativeAsset(targetRoot, target).toLowerCase(), path.toLowerCase());
  let current = targetRoot;
  for (const component of path.split('/')) {
    current = resolve(current, component);
    const metadata = await lstat(current);
    assert.ok(!metadata.isSymbolicLink(), 'Target asset paths must not contain links');
  }
  const actual = await realpath(target);
  relativeAsset(await realpath(targetRoot), actual);
  const metadata = await lstat(target);
  assert.ok(metadata.isFile() && metadata.size === expected.bytes, 'Verified target file is missing or changed');
  const digest = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(target)) { digest.update(chunk); bytes += chunk.length; }
  const after = await lstat(target);
  assert.ok(bytes === expected.bytes && digest.digest('hex') === expected.sha256
    && ['size', 'mtimeMs', 'ctimeMs', 'ino', 'dev'].every(key => metadata[key] === after[key]), 'Verified target file checksum or identity changed');
}

async function verifyTargetFiles(targetRoot, files, { concurrency, onProgress }) {
  await assertTargetRoot(targetRoot);
  const entries = [...files.values()], totalBytes = entries.reduce((sum, file) => sum + file.bytes, 0);
  let cursor = 0, verifiedFiles = 0, verifiedBytes = 0, failure;
  const progress = () => onProgress({ phase: 'verifying-target', verifiedFiles, totalFiles: entries.length, verifiedBytes, totalBytes });
  await progress();
  const workers = await Promise.allSettled(Array.from({ length: concurrency }, async () => {
    while (cursor < entries.length && !failure) {
      const file = entries[cursor++];
      try {
        await assertTargetFile(targetRoot, file.path, file);
        verifiedFiles += 1; verifiedBytes += file.bytes;
        await progress();
      } catch (error) { failure ??= error; throw error; }
    }
  }));
  if (failure) throw failure;
  const rejected = workers.find(worker => worker.status === 'rejected');
  if (rejected) throw rejected.reason;
  return verifiedFiles;
}

/**
 * Caller must stop production writes and finish an incremental copy first.
 * beforeCommit must undo its own partial failures; on success it returns an
 * environment undo callback. An unknown COMMIT outcome keeps the new environment
 * and requires a fresh database connection to confirm the result before restart.
 */
export async function migrateProductionStoragePaths(client, {
  sourceRoot, targetRoot, manifest, apply = false, assertOffline = assertStorageServiceStopped,
  beforeCommit, concurrency = 4, onProgress = () => {},
} = {}) {
  assert.ok(Number.isSafeInteger(concurrency) && concurrency >= 1 && concurrency <= 4, 'Target verification concurrency must be between 1 and 4');
  const source = canonicalPrefix(sourceRoot), target = canonicalPrefix(targetRoot);
  assert.notEqual(source.toLowerCase(), target.toLowerCase(), 'Storage roots must differ');
  const relation = relative(source, target), inverse = relative(target, source);
  const child = value => value && value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value);
  assert.ok(!child(relation) && !child(inverse), 'Storage roots must not contain each other');
  const files = manifest ? validateStorageCopyManifest(manifest, source, target) : null;
  if (apply) { assert.ok(files, 'Applying path changes requires a verified copy'); await assertOffline(); }
  let rollbackEnvironment, commitStarted = false;
  await client.query(apply ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' : 'BEGIN TRANSACTION READ ONLY');
  try {
    const database = (await client.query('SELECT current_database() AS name')).rows[0]?.name;
    assert.equal(database, 'xhs_control_prod', 'This migration is restricted to the production database');
    if (apply) {
      await client.query('LOCK TABLE assets,delivery_snapshot_assets,knowledge_versions,image_reference_cleanup_jobs,task_reassignment_cleanup IN SHARE ROW EXCLUSIVE MODE');
      const active = (await client.query(`SELECT
        (SELECT count(*) FROM task_executions WHERE status='RUNNING')
        +(SELECT count(*) FROM image_edit_requests WHERE status='RUNNING')
        +(SELECT count(*) FROM delivery_archive_jobs WHERE status IN ('QUEUED','RUNNING')) AS total`)).rows[0];
      assert.equal(Number(active.total), 0, 'Production operations must be idle before storage cutover');
    }
    const counts = [], existingTarget = [];
    for (const table of PATH_TABLES) {
      counts.push({ table, rows: await countPaths(client, table, source) });
      existingTarget.push(await countPaths(client, table, target));
    }
    assert.ok(!counts.some(item => item.rows) || !existingTarget.some(Boolean), 'Old and new paths coexist; inspect before migrating');
    if (!apply) {
      await client.query('COMMIT');
      return { sourceRoot: source, targetRoot: target, apply, counts, existingTarget };
    }
    const useRoot = counts.some(item => item.rows) ? source : target;
    const originals = (await client.query(`SELECT id,storage_path,sha256,byte_size,content_cleared_at FROM assets WHERE ${pathPredicate}`, [useRoot])).rows;
    const references = (await client.query(`SELECT snapshot_public_id,storage_path,sha256,byte_size FROM delivery_snapshot_assets WHERE ${pathPredicate}`, [useRoot])).rows;
    assert.ok(originals.length > 0, 'Production has no asset paths in the selected roots');
    const checked = new Set();
    for (const row of [...originals.filter(item => item.content_cleared_at == null), ...references]) {
      const path = relativeAsset(useRoot, row.storage_path), key = path.normalize('NFC').toLowerCase(), verified = files.get(key);
      assert.ok(verified && verified.sha256 === row.sha256 && verified.bytes === Number(row.byte_size), 'An original image or frozen reference does not match the verified copy');
      checked.add(key);
    }
    const verifiedFiles = await verifyTargetFiles(target, files, { concurrency, onProgress });
    if (useRoot === source) for (const { table, rows } of counts) {
      if (!rows) continue;
      const result = await client.query(`UPDATE ${table} SET storage_path=$2 || substring(storage_path FROM length($1)+1) WHERE ${pathPredicate}`, [source, target]);
      assert.equal(result.rowCount, rows, 'Path update count changed unexpectedly');
    }
    for (const table of PATH_TABLES) {
      assert.equal(await countPaths(client, table, source), 0, 'Old production paths remain');
    }
    await assertOffline();
    if (beforeCommit) rollbackEnvironment = await beforeCommit();
    commitStarted = true;
    await client.query('COMMIT');
    return { sourceRoot: source, targetRoot: target, apply, counts, verifiedOriginals: checked.size,
      verifiedFiles, frozenReferences: references.length, alreadyMigrated: useRoot === target };
  } catch (error) {
    if (commitStarted && !definiteCommitRejection(error)) {
      const unknown = new Error('Production storage COMMIT outcome is unknown. Keep production stopped and retain the new environment; confirm all five path tables through a new database connection before recovery or restart.', { cause: error });
      unknown.code = 'STORAGE_CUTOVER_COMMIT_UNKNOWN';
      throw unknown;
    }
    await client.query('ROLLBACK').catch(() => {});
    if (rollbackEnvironment) await rollbackEnvironment();
    throw error;
  }
}

export async function main(args = process.argv.slice(2)) {
  const value = name => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  assert.ok(args.every(arg => arg === '--apply' || /^--(?:source-root|target-root|manifest|report)=/u.test(arg)), 'Use --source-root=ABS --target-root=ABS [--manifest=FILE] [--report=FILE] [--apply]');
  const config = loadConfiguration({ profile: 'production', environment: {} }), client = connectDatabase(config);
  try {
    await client.connect();
    const manifest = value('manifest') ? JSON.parse(await readFile(value('manifest'), 'utf8')) : undefined;
    const result = await migrateProductionStoragePaths(client, { sourceRoot: value('source-root'), targetRoot: value('target-root'), manifest, apply: args.includes('--apply') });
    if (value('report')) await writeFile(value('report'), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result));
  } catch (error) { console.error(safeError(error, config)); process.exitCode = 1; }
  finally { await client.end(); }
}

if (isMain(import.meta.url)) await main();
