import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, open, readFile, rename, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { parseEnv } from 'node:util';
import { connectDatabase, isMain, loadConfiguration, parseOptions, safeError, SERVER_ROOT } from '../server/scripts/database-common.mjs';
import { migrateProductionStoragePaths } from './production-storage-paths.mjs';

const STORAGE_KEY = 'XHS_PRODUCTION_STORAGE_ROOT';
const samePath = (left, right) => resolve(left).toLowerCase() === resolve(right).toLowerCase();

async function realEnvironmentFile(path) {
  assert.ok(typeof path === 'string' && isAbsolute(path), 'Environment file must be absolute');
  const absolute = resolve(path), metadata = await lstat(absolute);
  assert.ok(metadata.isFile() && !metadata.isSymbolicLink(), 'Environment must be a regular file');
  let current = parse(absolute).root;
  for (const component of relative(current, dirname(absolute)).split(sep).filter(Boolean)) {
    current = join(current, component);
    const ancestor = await lstat(current);
    assert.ok(ancestor.isDirectory() && !ancestor.isSymbolicLink(), 'Environment ancestors must not redirect to another directory');
  }
  return absolute;
}

/** Keep secrets in memory; only the production storage key is changed. */
export function replaceProductionStorageRoot(contents, { sourceRoot, targetRoot }) {
  assert.ok(isAbsolute(sourceRoot) && isAbsolute(targetRoot), 'Storage roots must be absolute');
  assert.ok(!/[\r\n"\0]/u.test(targetRoot), 'Invalid production storage root');
  const source = parseEnv(contents);
  assert.ok(source[STORAGE_KEY] && (samePath(source[STORAGE_KEY], sourceRoot) || samePath(source[STORAGE_KEY], targetRoot)),
    'Environment production storage differs from both migration roots');
  const database = new URL(source.XHS_PRODUCTION_DATABASE_URL || 'missing:');
  assert.ok(['postgres:', 'postgresql:'].includes(database.protocol)
    && decodeURIComponent(database.pathname.slice(1)) === 'xhs_control_prod', 'Environment is not configured for the production database');
  const expression = /^([\t ]*(?:export[\t ]+)?XHS_PRODUCTION_STORAGE_ROOT[\t ]*=[\t ]*)([^\r\n]*)(\r?)$/gmu;
  const matches = [...contents.matchAll(expression)];
  assert.equal(matches.length, 1, 'Exactly one single-line production storage setting is required');
  const replacement = contents.replace(expression, (_, prefix, value, cr) => `${prefix}"${resolve(targetRoot)}"${cr}`);
  const changed = parseEnv(replacement);
  assert.equal(changed[STORAGE_KEY], resolve(targetRoot));
  assert.ok(Object.keys(changed).length === Object.keys(source).length
    && Object.keys(source).every(key => key === STORAGE_KEY || source[key] === changed[key]),
  'Changing the production storage root must preserve every other setting');
  return replacement;
}

async function atomicReplace(path, contents, expected) {
  assert.ok(await readFile(path, 'utf8') === expected, 'Environment file changed while preparing the cutover');
  assert.ok(samePath(parse(path).root, parse(resolve(tmpdir())).root), 'Private temporary directory must be on the environment volume');
  // Do not write credential-bearing temporary copies inside the repository.
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'xhs-production-storage-env-'));
  const temporary = join(temporaryDirectory, `${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try { await handle.writeFile(contents, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    // Recheck immediately before the rename so unrelated configuration edits are preserved.
    assert.ok(await readFile(path, 'utf8') === expected, 'Environment file changed before the cutover');
    await rename(temporary, path);
  } finally {
    try { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    finally { await rmdir(temporaryDirectory).catch(() => {}); }
  }
}

/** A beforeCommit hook that restores its own partial work as well as a failed DB commit. */
export async function prepareProductionStorageEnvironment({ environmentFiles, sourceRoot, targetRoot, replaceFile = atomicReplace }) {
  assert.ok(Array.isArray(environmentFiles) && environmentFiles.length > 0, 'Production environment file is required');
  const files = [];
  let databaseIdentity;
  for (const input of environmentFiles) {
    const path = await realEnvironmentFile(input);
    assert.ok(!files.some(file => samePath(file.path, path)), 'Duplicate production environment file');
    const original = await readFile(path, 'utf8');
    const database = new URL(parseEnv(original).XHS_PRODUCTION_DATABASE_URL || 'missing:');
    const identity = `${database.hostname.toLowerCase()}:${database.port || '5432'}${database.pathname}`;
    if (databaseIdentity) assert.equal(identity, databaseIdentity, 'Environment files point to different production databases');
    databaseIdentity = identity;
    files.push({ path, original, replacement: replaceProductionStorageRoot(original, { sourceRoot, targetRoot }) });
  }
  const restore = async changed => {
    const failures = [];
    for (const file of [...changed].reverse()) {
      try { await replaceFile(file.path, file.original, file.replacement); }
      catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Could not restore production environment files; keep production stopped');
  };
  return async () => {
    const changed = [];
    try {
      for (const file of files) {
        if (file.original === file.replacement) continue;
        try { await replaceFile(file.path, file.replacement, file.original); }
        catch (error) {
          let current;
          try { current = await readFile(file.path, 'utf8'); }
          catch (readError) { throw new AggregateError([error, readError], 'Environment write result cannot be confirmed; keep production stopped'); }
          if (current === file.replacement) changed.push(file);
          else if (current !== file.original) throw new AggregateError([error], 'Environment changed unexpectedly; keep production stopped');
          throw error;
        }
        changed.push(file);
      }
    } catch (error) {
      try { await restore(changed); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], 'Environment cutover failed and restoration requires attention; keep production stopped'); }
      throw error;
    }
    return () => restore(changed);
  };
}

async function checkedReportPath(path) {
  assert.ok(typeof path === 'string' && isAbsolute(path), 'Cutover report path must be absolute');
  const absolute = resolve(path);
  let current = parse(absolute).root;
  const components = [current, ...relative(current, dirname(absolute)).split(sep).filter(Boolean)];
  for (const [index, component] of components.entries()) {
    if (index) current = join(current, component);
    const metadata = await lstat(current);
    assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink(), 'Cutover report ancestors must be real directories');
  }
  return absolute;
}

async function writeSyncedFile(path, contents) {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(contents, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
}

async function replaceCutoverReport(path, contents, expected) {
  await checkedReportPath(path);
  const check = async () => {
    const metadata = await lstat(path);
    assert.ok(metadata.isFile() && !metadata.isSymbolicLink(), 'Reserved cutover report is not a regular file');
    assert.ok(await readFile(path, 'utf8') === expected, 'Reserved cutover report was changed externally');
  };
  await check();
  let temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeSyncedFile(temporary, contents);
    await check();
    await rename(temporary, path);
    temporary = null;
  } finally {
    if (temporary) await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

/** Reserve recovery evidence before the operation; report IO cannot undo a known commit. */
export async function withStorageCutoverReport({
  reportPath, sourceRoot, targetRoot, environmentFiles, apply = false,
}, operation, { replaceReport = replaceCutoverReport, formatError = safeError } = {}) {
  const path = await checkedReportPath(reportPath);
  const initial = { format: 'xhs-production-storage-cutover-report', version: 1,
    status: 'UNKNOWN', phase: 'IN_PROGRESS', apply, sourceRoot, targetRoot, environmentFiles,
    startedAt: new Date().toISOString() };
  const initialContents = `${JSON.stringify(initial, null, 2)}\n`;
  // A missing/unwritable parent or pre-existing path fails before database work.
  await writeSyncedFile(path, initialContents);
  let result;
  try { result = await operation(); }
  catch (error) {
    const failed = { ...initial, phase: 'FAILED', failedAt: new Date().toISOString(),
      error: formatError(error), recovery: 'Keep production stopped and verify the database paths and environment before recovery or restart.' };
    let reportFailure = '';
    try { await replaceReport(path, `${JSON.stringify(failed, null, 2)}\n`, initialContents); }
    catch (reportError) { reportFailure = ` Report update also failed: ${formatError(reportError)}.`; }
    const failure = new Error(`Production storage cutover status is UNKNOWN; keep production stopped. ${failed.error}.${reportFailure}`, { cause: error });
    failure.code = error.code === 'STORAGE_CUTOVER_COMMIT_UNKNOWN' ? error.code : 'STORAGE_CUTOVER_FAILED';
    throw failure;
  }
  const completed = { ...initial, ...result, status: apply ? 'COMMITTED' : 'PREVIEW_COMPLETE',
    phase: 'COMPLETE', completedAt: new Date().toISOString() };
  try {
    await replaceReport(path, `${JSON.stringify(completed, null, 2)}\n`, initialContents);
    return { ...result, status: completed.status, reportPath: path, reportSaved: true };
  } catch (error) {
    return { ...result, status: completed.status, reportPath: path, reportSaved: false,
      warning: `${apply ? 'Production storage cutover committed successfully' : 'Storage preview completed successfully'}; only the completion report could not be saved. The reserved report may still show UNKNOWN. Do not infer a database rollback from this reporting failure. ${formatError(error)}` };
  }
}

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args, ['source-root', 'target-root', 'manifest', 'report', 'additional-environment-file', 'apply']);
  const configuration = loadConfiguration({ profile: 'production', environment: {} });
  const client = connectDatabase(configuration);
  try {
    const sourceRoot = options['source-root'], targetRoot = options['target-root'];
    assert.ok(sourceRoot && targetRoot && options.manifest && options.report, 'Use --source-root=ABS --target-root=ABS --manifest=FILE --report=FILE [--apply]');
    const report = resolve(options.report);
    for (const root of [sourceRoot, targetRoot]) {
      const difference = relative(resolve(root), report);
      assert.ok(difference && (isAbsolute(difference) || difference === '..' || difference.startsWith(`..${sep}`)), 'Cutover report must be outside storage');
    }
    // Preparation reads and validates configuration without writing it.
    const environmentFiles = [join(SERVER_ROOT, '.env'), ...(options['additional-environment-file'] ? [options['additional-environment-file']] : [])];
    const beforeCommit = await prepareProductionStorageEnvironment({ environmentFiles, sourceRoot, targetRoot });
    const manifest = JSON.parse(await readFile(resolve(options.manifest), 'utf8'));
    let lastProgress = 0;
    const onProgress = progress => {
      if (Date.now() - lastProgress < 15_000 && progress.verifiedFiles !== progress.totalFiles) return;
      lastProgress = Date.now();
      console.log(JSON.stringify(progress));
    };
    const result = await withStorageCutoverReport({ reportPath: report, sourceRoot, targetRoot, environmentFiles, apply: options.apply === true }, async () => {
      await client.connect();
      return migrateProductionStoragePaths(client, { sourceRoot, targetRoot, manifest, apply: options.apply === true, beforeCommit, onProgress });
    }, { formatError: error => safeError(error, configuration) });
    console.log(JSON.stringify(result));
  } catch (error) { console.error(safeError(error, configuration)); process.exitCode = 1; }
  finally { await client.end(); }
}

if (isMain(import.meta.url)) await main();
