import assert from 'node:assert/strict';
import test from 'node:test';
import { executorConfig } from '../src/executor/config.mjs';

const environment = { CONTROL_PLANE_URL: 'http://localhost:4310', EXECUTOR_NODE_ID: 'test' };

test('node identity is normalized before registration and claim response validation', () => {
  assert.equal(executorConfig({ ...environment, EXECUTOR_NODE_ID: ' node-a ' }, []).nodeId, 'node-a');
  assert.equal(executorConfig(environment, ['--node-id= node-b ']).nodeId, 'node-b');
  assert.equal(executorConfig({ ...environment, DEEPSEEK_SIM_NODE_ID: ' sim ' }, [], { simulation: true }).nodeId, 'sim');
  assert.throws(() => executorConfig(environment, ['--node-id=  ']), /required/);
});

test('executor task capacities default independently to one and read env overrides', () => {
  const defaults = executorConfig(environment, []);
  assert.equal(defaults.copyConcurrency, 1);
  assert.equal(defaults.imageConcurrency, 1);
  assert.equal(defaults.imageWorkerEnabled, false);
  const config = executorConfig({ ...environment, EXECUTOR_COPY_CONCURRENCY: '3',
    EXECUTOR_IMAGE_CONCURRENCY: '2', IMAGE_WORKER_ENABLED: 'true' }, []);
  assert.equal(config.copyConcurrency, 3);
  assert.equal(config.imageConcurrency, 2);
  assert.equal(config.imageWorkerEnabled, true);
});

test('capacities reject empty, non-decimal, fractional and out-of-range configuration', () => {
  for (const name of ['EXECUTOR_COPY_CONCURRENCY', 'EXECUTOR_IMAGE_CONCURRENCY']) {
    for (const value of ['', ' ', '0', '-1', '1.5', '33', 'NaN', '0x2', '1e1']) {
      assert.throws(() => executorConfig({ ...environment, [name]: value }, []), new RegExp(name));
    }
  }
});

test('both executor entries share flags and preserve simulation identity and once', () => {
  const config = executorConfig({ ...environment, IMAGE_WORKER_ENABLED: 'true' },
    ['--disable-image-worker', '--once', '--poll-ms=1000'], { simulation: true });
  assert.equal(config.nodeId, 'test-deepseek-sim');
  assert.equal(config.imageWorkerEnabled, false);
  assert.equal(config.once, true);
  assert.equal(config.pollMs, 1000);
  assert.throws(() => executorConfig(environment, ['--enable-image-worker', '--disable-image-worker']), /cannot/);
});

test('idle polling and settings transport cache have bounded, independently configurable defaults', () => {
  const defaults = executorConfig(environment, []);
  assert.equal(defaults.idleMaxPollMs, 20000);
  assert.equal(defaults.settingsCacheMs, 15_000);
  assert.equal(executorConfig(environment, ['--poll-ms=60000']).idleMaxPollMs, 60_000);
  const custom = executorConfig(environment, ['--idle-max-poll-ms=10000', '--settings-cache-ms=0']);
  assert.equal(custom.idleMaxPollMs, 10_000);
  assert.equal(custom.settingsCacheMs, 0);
  for (const value of ['4999', '60001', 'NaN']) {
    assert.throws(() => executorConfig(environment, [`--idle-max-poll-ms=${value}`]), /idle maximum/);
  }
  for (const value of ['-1', '60001', '1.5']) {
    assert.throws(() => executorConfig(environment, [`--settings-cache-ms=${value}`]), /settings cache/);
  }
});
