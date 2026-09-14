import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  applyServerEnvironment,
  loadServerEnvironment,
  serverEnvironmentProfile,
} from '../src/server-environment.mjs';

test('server environment defaults to development and accepts one explicit production selector', () => {
  assert.equal(serverEnvironmentProfile([], {}), 'development');
  assert.equal(serverEnvironmentProfile([], { XHS_SERVER_ENV: 'production' }), 'production');
  assert.equal(serverEnvironmentProfile(['--environment=production'], { XHS_SERVER_ENV: 'development' }), 'production');
  for (const args of [['--environment=staging'], ['--environment'], ['--environment=production', '--environment=development']]) {
    assert.throws(() => serverEnvironmentProfile(args, {}), /environment/u);
  }
});

test('production environment selects dedicated values from the shared env file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xhs-server-env-'));
  try {
    await writeFile(join(root, '.env'), `DATABASE_URL=postgresql://dev@localhost/dev
XHS_PRODUCTION_DATABASE_URL=postgresql://prod@localhost/prod
XHS_PRODUCTION_STORAGE_ROOT=prod-storage
CONTROL_PLANE_PORT=4310
SHARED=value
`);
    const selected = loadServerEnvironment({
      args: ['--environment=production'], environment: { PROCESS_ONLY: 'yes' }, serverRoot: root,
    });
    assert.equal(selected.profile, 'production');
    assert.equal(selected.environment.DATABASE_URL, 'postgresql://prod@localhost/prod');
    assert.equal(selected.environment.CONTROL_PLANE_STORAGE_ROOT, 'prod-storage');
    assert.equal(selected.environment.CONTROL_PLANE_PORT, '4310');
    assert.equal(selected.environment.SHARED, 'value');
    assert.equal(selected.environment.PROCESS_ONLY, 'yes');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('production selection cannot silently fall back to DATABASE_URL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xhs-server-env-'));
  try {
    await writeFile(join(root, '.env'), 'DATABASE_URL=postgresql://dev@localhost/dev\n');
    assert.throws(
      () => loadServerEnvironment({ profile: 'production', environment: {}, serverRoot: root }),
      /XHS_PRODUCTION_DATABASE_URL/u,
    );
    const selected = loadServerEnvironment({
      profile: 'production', environment: { XHS_PRODUCTION_DATABASE_URL: 'postgresql://injected@localhost/prod' }, serverRoot: root,
    });
    assert.equal(selected.environment.DATABASE_URL, 'postgresql://injected@localhost/prod');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('selected server environment is applied for runtime consumers', () => {
  const target = { UNRELATED: 'preserved' };
  const applied = applyServerEnvironment({
    DATABASE_URL: 'postgresql://prod@localhost/prod',
    CONTROL_PLANE_STORAGE_ROOT: 'prod-storage',
    XHS_SEARCH_MACHINE_TOKEN: 'shared-machine-token',
  }, target);

  assert.equal(applied, target);
  assert.deepEqual(target, {
    UNRELATED: 'preserved',
    DATABASE_URL: 'postgresql://prod@localhost/prod',
    CONTROL_PLANE_STORAGE_ROOT: 'prod-storage',
    XHS_SEARCH_MACHINE_TOKEN: 'shared-machine-token',
  });
});
