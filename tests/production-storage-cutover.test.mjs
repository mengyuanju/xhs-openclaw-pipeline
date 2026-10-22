import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { parseEnv } from 'node:util';
import test from 'node:test';
import { prepareProductionStorageEnvironment, replaceProductionStorageRoot, withStorageCutoverReport } from '../scripts/production-storage-cutover.mjs';
import { safeError } from '../server/scripts/database-common.mjs';

const sourceRoot = join(tmpdir(), 'production-storage-source');
const targetRoot = join(tmpdir(), 'production-storage-destination');
const environment = (root = sourceRoot) => [
  '# Keep unrelated settings and comments verbatim',
  'DATABASE_URL=postgresql://development:local-test@127.0.0.1:5432/xhs_control',
  'XHS_PRODUCTION_DATABASE_URL=postgresql://production:local-test@127.0.0.1:5432/xhs_control_prod',
  `XHS_PRODUCTION_STORAGE_ROOT="${root}" # previous storage`,
  'CONTROL_PLANE_STORAGE_ROOT=development-images',
  'ANOTHER_VALUE="preserved # as text"', '',
].join('\r\n');

test('changes only the production storage setting and preserves CRLF and all other settings', () => {
  const original = environment(), actual = replaceProductionStorageRoot(original, { sourceRoot, targetRoot });
  assert.equal(parseEnv(actual).XHS_PRODUCTION_STORAGE_ROOT, targetRoot);
  assert.equal(actual.split('\r\n').length, original.split('\r\n').length);
  assert.deepEqual(actual.split('\r\n').filter(line => !line.startsWith('XHS_PRODUCTION_STORAGE_ROOT=')),
    original.split('\r\n').filter(line => !line.startsWith('XHS_PRODUCTION_STORAGE_ROOT=')));
  assert.equal(parseEnv(actual).CONTROL_PLANE_STORAGE_ROOT, 'development-images');
});

test('rejects a different source, duplicate setting, non-production database, and multiline replacement', () => {
  assert.throws(() => replaceProductionStorageRoot(environment(join(tmpdir(), 'other')), { sourceRoot, targetRoot }), /differs/u);
  assert.throws(() => replaceProductionStorageRoot(`${environment()}XHS_PRODUCTION_STORAGE_ROOT="${sourceRoot}"\n`, { sourceRoot, targetRoot }), /Exactly one/u);
  assert.throws(() => replaceProductionStorageRoot(environment().replace('/xhs_control_prod', '/xhs_control'), { sourceRoot, targetRoot }), /production database/u);
  assert.throws(() => replaceProductionStorageRoot(environment(), { sourceRoot, targetRoot: `${targetRoot}\nINJECTED=value` }), /Invalid/u);
});

test('preparing a cutover is read only; returned rollback restores both files byte-for-byte', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xhs-env-cutover-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = [join(root, 'production.env'), join(root, 'development-clone.env')], original = environment();
  for (const path of paths) await writeFile(path, original);
  const commitHook = await prepareProductionStorageEnvironment({ environmentFiles: paths, sourceRoot, targetRoot });
  for (const path of paths) assert.equal(await readFile(path, 'utf8'), original);
  const rollback = await commitHook();
  for (const path of paths) assert.equal(parseEnv(await readFile(path, 'utf8')).XHS_PRODUCTION_STORAGE_ROOT, targetRoot);
  await rollback();
  for (const path of paths) assert.equal(await readFile(path, 'utf8'), original);
  assert.deepEqual((await readdir(root)).sort(), ['development-clone.env', 'production.env']);
});

test('failure on the second file immediately restores the first without waiting for a returned hook', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xhs-env-cutover-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = [join(root, 'first.env'), join(root, 'second.env')], original = environment();
  for (const path of paths) await writeFile(path, original);
  let calls = 0;
  const hook = await prepareProductionStorageEnvironment({ environmentFiles: paths, sourceRoot, targetRoot,
    replaceFile: async (path, contents, expected) => {
      assert.equal(await readFile(path, 'utf8'), expected);
      if (++calls === 2) throw new Error('simulated write failure');
      await writeFile(path, contents);
    },
  });
  await assert.rejects(hook, /simulated write failure/u);
  for (const path of paths) assert.equal(await readFile(path, 'utf8'), original);
});

test('concurrent environment edits cause a refusal and are preserved', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xhs-env-cutover-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'production.env');
  await writeFile(path, environment());
  const hook = await prepareProductionStorageEnvironment({ environmentFiles: [path], sourceRoot, targetRoot });
  const edited = `${environment()}USER_EDIT=preserve\r\n`;
  await writeFile(path, edited);
  await assert.rejects(hook, /changed/u);
  assert.equal(await readFile(path, 'utf8'), edited);
});

test('an error reported after a completed replacement still restores every changed file', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xhs-env-cutover-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = [join(root, 'first.env'), join(root, 'second.env')], original = environment();
  for (const path of paths) await writeFile(path, original);
  let calls = 0;
  const hook = await prepareProductionStorageEnvironment({ environmentFiles: paths, sourceRoot, targetRoot,
    replaceFile: async (path, contents, expected) => {
      assert.equal(await readFile(path, 'utf8'), expected);
      await writeFile(path, contents);
      if (++calls === 2) throw new Error('simulated cleanup failure after replacement');
    },
  });
  await assert.rejects(hook, /simulated cleanup failure/u);
  for (const path of paths) assert.equal(await readFile(path, 'utf8'), original);
});

test('environment clones must refer to the same production database', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xhs-env-cutover-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = [join(root, 'first.env'), join(root, 'second.env')];
  await writeFile(paths[0], environment());
  await writeFile(paths[1], environment().replaceAll('127.0.0.1', '127.0.0.2'));
  await assert.rejects(prepareProductionStorageEnvironment({ environmentFiles: paths, sourceRoot, targetRoot }), /different production databases/u);
  assert.equal(await readFile(paths[0], 'utf8'), environment());
});

async function reportFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'xhs-cutover-report-'));
  t.after(async () => {
    const suffix = relative(tmpdir(), root);
    assert.ok(suffix.startsWith('xhs-cutover-report-') && !suffix.includes(sep) && !isAbsolute(suffix));
    await rm(root, { recursive: true, force: true });
  });
  return { root, input: { reportPath: join(root, 'report.json'), sourceRoot, targetRoot,
    environmentFiles: [join(root, 'primary.env'), join(root, 'secondary.env')], apply: true } };
}

test('report is reserved before the operation and atomically records a confirmed commit', async t => {
  const f = await reportFixture(t);
  const outcome = await withStorageCutoverReport(f.input, async () => {
    const reserved = JSON.parse(await readFile(f.input.reportPath, 'utf8'));
    assert.equal(reserved.status, 'UNKNOWN');
    assert.equal(reserved.phase, 'IN_PROGRESS');
    assert.deepEqual(reserved.environmentFiles, f.input.environmentFiles);
    return { apply: true, verifiedOriginals: 3 };
  });
  assert.equal(outcome.status, 'COMMITTED');
  assert.equal(outcome.reportSaved, true);
  const report = JSON.parse(await readFile(f.input.reportPath, 'utf8'));
  assert.equal(report.status, 'COMMITTED');
  assert.equal(report.verifiedOriginals, 3);
  assert.deepEqual(await readdir(f.root), ['report.json']);
});

test('missing report directory or an existing report refuses before database work', async t => {
  const f = await reportFixture(t);
  const operation = () => assert.fail('report reservation must precede database work');
  await assert.rejects(withStorageCutoverReport({ ...f.input, reportPath: join(f.root, 'missing', 'report.json') }, operation), { code: 'ENOENT' });
  await writeFile(f.input.reportPath, 'existing report');
  await assert.rejects(withStorageCutoverReport(f.input, operation), { code: 'EEXIST' });
  assert.equal(await readFile(f.input.reportPath, 'utf8'), 'existing report');
});

test('completion-report failure returns a confirmed commit without suggesting database rollback', async t => {
  const f = await reportFixture(t);
  let calls = 0;
  const outcome = await withStorageCutoverReport(f.input, async () => {
    calls += 1;
    return { apply: true, verifiedOriginals: 3 };
  }, { replaceReport: async () => { throw new Error('simulated report disk failure'); } });
  assert.equal(calls, 1);
  assert.equal(outcome.status, 'COMMITTED');
  assert.equal(outcome.reportSaved, false);
  assert.equal(outcome.verifiedOriginals, 3);
  assert.match(outcome.warning, /committed successfully/u);
  assert.match(outcome.warning, /only the completion report/u);
  assert.equal(JSON.parse(await readFile(f.input.reportPath, 'utf8')).status, 'UNKNOWN');
});

test('unknown commit writes recovery status without credentials and preserves the error code', async t => {
  const f = await reportFixture(t);
  const connectionString = 'postgresql://fixture:private-test-secret@127.0.0.1:5432/xhs_control_prod';
  const config = { connectionString, environment: { PGPASSWORD: 'private-test-secret' } };
  const operation = async () => {
    throw Object.assign(new Error(`Commit result lost for ${connectionString}; private-test-secret`), { code: 'STORAGE_CUTOVER_COMMIT_UNKNOWN' });
  };
  await assert.rejects(withStorageCutoverReport(f.input, operation, { formatError: error => safeError(error, config) }), error => {
    assert.equal(error.code, 'STORAGE_CUTOVER_COMMIT_UNKNOWN');
    assert.match(error.message, /UNKNOWN; keep production stopped/u);
    assert.ok(!error.message.includes('private-test-secret'));
    return true;
  });
  const contents = await readFile(f.input.reportPath, 'utf8'), report = JSON.parse(contents);
  assert.equal(report.status, 'UNKNOWN');
  assert.equal(report.phase, 'FAILED');
  assert.ok(!contents.includes('private-test-secret'));
  assert.match(report.recovery, /Keep production stopped/u);
});

test('operation and report failures retain the reserved UNKNOWN record', async t => {
  const f = await reportFixture(t);
  await assert.rejects(withStorageCutoverReport(f.input, async () => { throw new Error('operation failed'); }, {
    replaceReport: async () => { throw new Error('report failed'); },
  }), error => {
    assert.match(error.message, /status is UNKNOWN/u);
    assert.match(error.message, /operation failed/u);
    assert.match(error.message, /Report update also failed/u);
    return true;
  });
  const report = JSON.parse(await readFile(f.input.reportPath, 'utf8'));
  assert.equal(report.status, 'UNKNOWN');
  assert.equal(report.phase, 'IN_PROGRESS');
});

test('a concurrent report edit is preserved while the confirmed result remains explicit', async t => {
  const f = await reportFixture(t), external = '{"external":"preserve"}\n';
  const outcome = await withStorageCutoverReport(f.input, async () => {
    await writeFile(f.input.reportPath, external);
    return { apply: true };
  });
  assert.equal(outcome.status, 'COMMITTED');
  assert.equal(outcome.reportSaved, false);
  assert.equal(await readFile(f.input.reportPath, 'utf8'), external);
});

test('a preview report never claims a committed storage cutover', async t => {
  const f = await reportFixture(t);
  const outcome = await withStorageCutoverReport({ ...f.input, apply: false }, async () => ({ apply: false, counts: [] }));
  assert.equal(outcome.status, 'PREVIEW_COMPLETE');
  assert.equal(JSON.parse(await readFile(f.input.reportPath, 'utf8')).status, 'PREVIEW_COMPLETE');
});

test('report directory links are refused before creating a report or calling the operation', async t => {
  const f = await reportFixture(t), real = join(f.root, 'real'), alias = join(f.root, 'alias');
  await mkdir(real);
  await symlink(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(withStorageCutoverReport({ ...f.input, reportPath: join(alias, 'report.json') }, () => {
    assert.fail('must not start database work');
  }), /real directories/u);
  assert.deepEqual(await readdir(real), []);
});
