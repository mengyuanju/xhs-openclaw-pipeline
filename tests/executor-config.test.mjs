import assert from 'node:assert/strict';
import test from 'node:test';
import { executorConfig } from '../src/executor/config.mjs';

const environment = { CONTROL_PLANE_URL: 'http://localhost:4310', EXECUTOR_NODE_ID: 'test' };

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
