import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  assertStorageSeparated,
  inspectDevelopmentConfiguration,
  main,
} from '../scripts/start-development.mjs';

const temporaryRoots = [];
const developmentUrl = 'postgresql://dev_user@127.0.0.1:5432/dev_fixture';
const productionUrl = 'postgresql://prod_user@127.0.0.1:5432/prod_fixture';

async function fixture({ productionDatabase = productionUrl, overlappingStorage = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xhs-start-development-test-')));
  temporaryRoots.push(root);
  const developmentStorage = join(root, 'storage-development');
  const productionStorage = overlappingStorage
    ? join(developmentStorage, 'nested-production') : join(root, 'storage-production');
  await mkdir(join(root, 'server'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'next', 'dist', 'bin'), { recursive: true });
  await writeFile(join(root, 'node_modules', 'next', 'dist', 'bin', 'next'), '');
  await writeFile(join(root, 'server', '.env'), [
    `DATABASE_URL=${developmentUrl}`,
    `XHS_PRODUCTION_DATABASE_URL=${productionDatabase}`,
    `CONTROL_PLANE_STORAGE_ROOT=${developmentStorage.replaceAll('\\', '/')}`,
    `XHS_PRODUCTION_STORAGE_ROOT=${productionStorage.replaceAll('\\', '/')}`,
    'CONTROL_PLANE_PORT=4999',
    'CONTROL_PLANE_HOST=0.0.0.0',
  ].join('\n'));
  return { root, developmentStorage, productionStorage };
}

function inheritedProductionEnvironment() {
  return {
    DATABASE_URL: productionUrl,
    XHS_SERVER_ENV: 'production',
    XHS_PRODUCTION_DATABASE_URL: productionUrl,
    CONTROL_PLANE_URL: 'https://production.example.invalid',
    CONTROL_PLANE_PORT: '4310',
    CONTROL_PLANE_HOST: '0.0.0.0',
    XHS_NEXT_DIST_DIR: '.next',
    XHS_SESSION_SECRET: 'inherited-production-session-secret',
  };
}

function healthyResponse() {
  return { ok: true, status: 200, json: async () => ({
    data: { ok: true, xhsSearchMachineTokenConfigured: false },
  }) };
}

function fakeProcesses() {
  const spawned = [];
  const terminated = [];
  return {
    spawned,
    terminated,
    spawnImpl(command, args, options) {
      const child = new EventEmitter();
      child.pid = 10_000 + spawned.length;
      spawned.push({ command, args, options, child });
      return child;
    },
    async terminateTreeImpl(state) {
      terminated.push(state.name);
      if (!state.outcome) state.child.emit('exit', null, 'SIGTERM');
      await state.finished;
    },
  };
}

async function until(predicate, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`Timed out waiting for ${label}`);
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('development launcher safety', () => {
  it('rejects a production database alias and overlapping storage directories', async () => {
    const sameDatabase = await fixture({
      productionDatabase: 'postgresql://another_user@localhost:5432/dev_fixture',
    });
    assert.throws(() => inspectDevelopmentConfiguration({
      environment: {}, projectRoot: sameDatabase.root,
    }), /same database/u);

    const overlapping = await fixture({ overlappingStorage: true });
    assert.throws(() => inspectDevelopmentConfiguration({
      environment: {}, projectRoot: overlapping.root,
    }), /cannot contain each other/u);
    assert.doesNotThrow(() => assertStorageSeparated(
      overlapping.developmentStorage,
      join(overlapping.root, 'storage-development-sibling'),
    ));
  });

  it('uses file-backed development settings despite an inherited production shell; check-only never spawns', async () => {
    const { root, developmentStorage } = await fixture();
    const environment = inheritedProductionEnvironment();
    const config = inspectDevelopmentConfiguration({ environment, projectRoot: root });
    assert.equal(config.controlPlaneEnvironment.DATABASE_URL, developmentUrl);
    assert.equal(config.controlPlaneEnvironment.XHS_SERVER_ENV, 'development');
    assert.equal(config.controlPlaneEnvironment.CONTROL_PLANE_PORT, '4311');
    assert.equal(config.controlPlaneEnvironment.CONTROL_PLANE_HOST, '0.0.0.0');
    assert.equal(config.controlPlaneEnvironment.CONTROL_PLANE_URL, 'http://127.0.0.1:4311');
    assert.equal(config.controlPlaneEnvironment.CONTROL_PLANE_STORAGE_ROOT, developmentStorage);
    assert.equal(config.webEnvironment.CONTROL_PLANE_URL, 'http://127.0.0.1:4311');
    assert.equal(config.webEnvironment.XHS_NEXT_DIST_DIR, '.next-dev-4311');
    assert.equal(config.webEnvironment.NODE_ENV, 'development');
    assert.equal(config.webEnvironment.DATABASE_URL, undefined);

    const ports = [];
    const result = await main(['--check-only'], {
      environment, projectRoot: root,
      checkPortImpl: async (port, host) => ports.push([port, host]),
      spawnImpl: () => assert.fail('check-only must not spawn a child'),
      log: () => {},
    });
    assert.equal(result.checkOnly, true);
    assert.deepEqual(ports, [[4311, '0.0.0.0'], [3002, '127.0.0.1']]);
  });

  for (const occupiedPort of [4311, 3002]) {
    it(`does not spawn when port ${occupiedPort} is occupied and explains how to use an existing instance`, async () => {
      const { root } = await fixture();
      let spawnCount = 0;
      await assert.rejects(main([], {
        environment: inheritedProductionEnvironment(), projectRoot: root,
        checkPortImpl: async port => { if (port === occupiedPort) throw new Error('in use'); },
        spawnImpl: () => { spawnCount += 1; assert.fail('port preflight must block spawning'); },
        log: () => {},
      }), error => {
        assert.match(error.message, new RegExp(`端口 ${occupiedPort}`, 'u'));
        assert.match(error.message, /本次未启动新服务/u);
        assert.match(error.message, /http:\/\/127\.0\.0\.1:3002/u);
        assert.match(error.message, /http:\/\/127\.0\.0\.1:4311/u);
        assert.match(error.message, /开发中心使用 4311，生产中心保留 4310/u);
        assert.match(error.message, /先关闭占用端口的旧服务/u);
        return true;
      });
      assert.equal(spawnCount, 0);
    });
  }

  it('starts web only after center health and cleans both owned children on Ctrl+C', async () => {
    const { root, developmentStorage } = await fixture();
    const processes = fakeProcesses();
    const signals = new EventEmitter();
    let releaseHealth;
    const health = new Promise(resolve => { releaseHealth = resolve; });
    let healthCalls = 0;
    const running = main([], {
      environment: inheritedProductionEnvironment(), projectRoot: root,
      checkPortImpl: async () => {},
      fetchImpl: url => {
        assert.equal(url, 'http://127.0.0.1:4311/health', 'development readiness must not probe production');
        healthCalls += 1;
        return healthCalls === 1
          ? Promise.resolve({ ok: true, json: async () => ({ ok: true, xhsSearchMachineTokenConfigured: false }) })
          : health;
      },
      delayImpl: async () => {},
      spawnImpl: processes.spawnImpl,
      terminateTreeImpl: processes.terminateTreeImpl,
      signals,
      log: () => {},
    });
    await until(() => healthCalls >= 2, 'second health probe');
    assert.equal(processes.spawned.length, 1, 'flat JSON and pending health must not start web');
    releaseHealth(healthyResponse());
    await until(() => processes.spawned.length === 2, 'web spawn');

    const [controlPlane, web] = processes.spawned;
    assert.equal(controlPlane.options.env.DATABASE_URL, developmentUrl);
    assert.equal(controlPlane.options.env.CONTROL_PLANE_STORAGE_ROOT, developmentStorage);
    assert.equal(controlPlane.options.env.CONTROL_PLANE_PORT, '4311');
    assert.equal(controlPlane.options.env.CONTROL_PLANE_HOST, '0.0.0.0');
    assert.equal(controlPlane.options.env.CONTROL_PLANE_URL, 'http://127.0.0.1:4311');
    assert.equal(controlPlane.options.shell, false);
    assert.equal(web.options.env.CONTROL_PLANE_URL, 'http://127.0.0.1:4311');
    assert.equal(web.options.env.XHS_NEXT_DIST_DIR, '.next-dev-4311');
    assert.equal(web.options.env.NODE_ENV, 'development');
    assert.match(web.options.env.XHS_SESSION_SECRET, /^[a-f0-9]{64}$/u);
    assert.notEqual(web.options.env.XHS_SESSION_SECRET, 'inherited-production-session-secret');
    assert.deepEqual(web.args.slice(-5), ['dev', '-H', '127.0.0.1', '-p', '3002']);
    assert.equal(web.options.shell, false);

    signals.emit('SIGINT');
    assert.deepEqual(await running, { stopped: true });
    assert.deepEqual(processes.terminated.sort(), ['Development control plane', 'Development web']);
    assert.equal(signals.listenerCount('SIGINT'), 0);
    assert.equal(signals.listenerCount('SIGTERM'), 0);
  });

  it('never starts web if the control plane exits before health', async () => {
    const { root } = await fixture();
    const processes = fakeProcesses();
    const running = main([], {
      environment: {}, projectRoot: root,
      checkPortImpl: async () => {},
      fetchImpl: async () => ({ ok: false, status: 503 }),
      delayImpl: () => new Promise(() => {}),
      spawnImpl: processes.spawnImpl,
      terminateTreeImpl: processes.terminateTreeImpl,
      signals: new EventEmitter(), log: () => {},
    });
    await until(() => processes.spawned.length === 1, 'control-plane spawn');
    processes.spawned[0].child.emit('exit', 1, null);
    await assert.rejects(running, /before it was healthy/u);
    assert.equal(processes.spawned.length, 1);
    assert.deepEqual(processes.terminated, ['Development control plane']);
  });

  for (const failedChild of [
    { index: 0, name: 'Development control plane' },
    { index: 1, name: 'Development web' },
  ]) {
    it(`cleans both owned children when ${failedChild.name} fails`, async () => {
      const { root } = await fixture();
      const processes = fakeProcesses();
      const running = main([], {
        environment: {}, projectRoot: root,
        checkPortImpl: async () => {},
        fetchImpl: async () => healthyResponse(),
        spawnImpl: processes.spawnImpl,
        terminateTreeImpl: processes.terminateTreeImpl,
        signals: new EventEmitter(), log: () => {},
      });
      await until(() => processes.spawned.length === 2, 'web spawn');
      processes.spawned[failedChild.index].child.emit('exit', 1, null);
      await assert.rejects(running, new RegExp(`${failedChild.name} stopped unexpectedly`, 'u'));
      assert.deepEqual(processes.terminated.sort(), ['Development control plane', 'Development web']);
    });
  }
});
