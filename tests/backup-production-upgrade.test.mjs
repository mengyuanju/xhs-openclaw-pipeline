import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, parse, relative, sep } from 'node:path';
import { test } from 'node:test';

import { backupProductionStorage, productionConfiguration } from '../scripts/backup-production-upgrade.mjs';

async function fixture(t) {
  const temporaryParent = await realpath(tmpdir());
  const root = await realpath(await mkdtemp(join(temporaryParent, 'xhs-production-backup-test-')));
  t.after(async () => {
    const suffix = relative(temporaryParent, root);
    assert.ok(suffix.startsWith('xhs-production-backup-test-') && !suffix.includes(sep) && !isAbsolute(suffix));
    await rm(root, { recursive: true, force: true });
  });
  const serverRoot = join(root, 'server');
  const development = join(root, 'development');
  const production = join(root, 'production');
  const backup = join(root, 'backup');
  await Promise.all([serverRoot, development, production, backup].map(path => mkdir(path)));
  async function configure(storageRoot = production, developmentRoot = development) {
    await writeFile(join(serverRoot, '.env'), [
      'DATABASE_URL=postgresql://fixture@127.0.0.1:5432/development_fixture',
      'XHS_PRODUCTION_DATABASE_URL=postgresql://fixture@127.0.0.1:5432/xhs_control_prod',
      `CONTROL_PLANE_STORAGE_ROOT=${developmentRoot.replaceAll('\\', '/')}`,
      ...(storageRoot === null ? [] : [`XHS_PRODUCTION_STORAGE_ROOT=${storageRoot.replaceAll('\\', '/')}`]),
    ].join('\n'));
  }
  await configure();
  return { root, serverRoot, development, production, backup, configure };
}

test('production backup follows the explicit profile storage after a directory switch', async t => {
  const f = await fixture(t);
  const replacement = join(f.root, 'replacement-volume-storage');
  await mkdir(replacement);
  await f.configure(replacement);
  const config = productionConfiguration({ serverRoot: f.serverRoot, environment: {
    DATABASE_URL: 'postgresql://fixture@127.0.0.1:5432/xhs_control_prod',
    CONTROL_PLANE_STORAGE_ROOT: replacement,
  } });
  assert.equal(config.storageRoot, await realpath(replacement));
  assert.equal(config.database, 'xhs_control_prod');
});

test('production backup refuses missing, relative, volume-root, absent and linked storage', async t => {
  const f = await fixture(t);
  for (const storage of [null, 'relative-storage', parse(f.root).root, join(f.root, 'missing')]) {
    await f.configure(storage);
    assert.throws(() => productionConfiguration({ serverRoot: f.serverRoot, environment: {} }));
  }
  const linked = join(f.root, 'linked-storage');
  await symlink(f.production, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await f.configure(linked);
  assert.throws(() => productionConfiguration({ serverRoot: f.serverRoot, environment: {} }), /link|junction/u);
});

test('production backup refuses storage shared with or containing development', async t => {
  const f = await fixture(t);
  const child = join(f.production, 'development-child');
  await mkdir(child);
  for (const development of [f.production, child, f.root]) {
    await f.configure(f.production, development);
    assert.throws(() => productionConfiguration({ serverRoot: f.serverRoot, environment: {} }), /separate/u);
  }
});

test('storage backup copies and verifies the selected root including snapshot files', async t => {
  const f = await fixture(t);
  t.mock.method(console, 'log', () => {});
  await mkdir(join(f.production, '.delivery-snapshots'));
  await mkdir(join(f.production, 'empty'));
  await writeFile(join(f.production, 'original.png'), 'local-original-fixture');
  await writeFile(join(f.production, '.delivery-snapshots', 'batch.json'), '{"fixture":true}\n');
  const report = {};
  const result = await backupProductionStorage(f.backup, report, { storageRoot: f.production });
  assert.equal(result.source, await realpath(f.production));
  assert.equal(result.verifiedFiles, 2);
  assert.equal(report.phase, 'COMPLETE');
  const manifest = JSON.parse(await readFile(result.manifest, 'utf8'));
  assert.equal(manifest.validation.sourceAndDestinationSha256Matched, true);
  assert.equal(manifest.validation.sourceUnchangedDuringCopy, true);
  assert.equal(await readFile(join(f.backup, 'storage', 'original.png'), 'utf8'), 'local-original-fixture');
  assert.equal(await readFile(join(f.backup, 'storage', '.delivery-snapshots', 'batch.json'), 'utf8'), '{"fixture":true}\n');
  assert.deepEqual(await readdir(join(f.backup, 'storage', 'empty')), []);
});

test('storage backup refuses nested source or destination before creating output', async t => {
  const f = await fixture(t);
  const child = join(f.production, 'backup-child');
  await mkdir(child);
  await assert.rejects(backupProductionStorage(child, {}, { storageRoot: f.production }), /separate/u);
  assert.deepEqual(await readdir(child), []);
  await assert.rejects(backupProductionStorage(f.root, {}, { storageRoot: f.production }), /separate/u);
  await assert.rejects(backupProductionStorage(f.backup, {}), /absolute directory/u);
  assert.deepEqual(await readdir(f.backup), []);
});
