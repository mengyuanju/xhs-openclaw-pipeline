import assert from 'node:assert/strict';
import test from 'node:test';
import { canResumeImageTask, requestImageResume } from '../src/control-plane/image-resume.mjs';

test('only failed image tasks with approved copy and no active execution can resume', () => {
  const task = { state: 'IMAGE_FAILED', currentCopyRevisionId: 12, currentExecutionId: null };
  assert.equal(canResumeImageTask(task), true);
  for (const patch of [{ state: 'IMAGE_RUNNING' }, { state: 'IMAGE_QUEUED' },
    { state: 'COPY_REVIEW_PENDING' }, { state: 'MANUAL_ARCHIVE' },
    { currentCopyRevisionId: null }, { currentExecutionId: 'running' }]) {
    assert.equal(canResumeImageTask({ ...task, ...patch }), false);
  }
});

test('unsupported centers do not enqueue a fresh generation when resuming', async () => {
  const writes = [];
  const request = async (url, init) => {
    if (init?.method === 'POST') writes.push(url);
    return { capabilities: {} };
  };
  await assert.rejects(requestImageResume(request, 12), /尚未支持断点续跑/);
  assert.deepEqual(writes, []);
});

test('resume preserves configuration and surfaces missing checkpoints without falling back', async () => {
  const writes = [];
  const request = async (url, init) => {
    if (!init) return { capabilities: { imageResume: true } };
    writes.push({ url, body: JSON.parse(init.body) });
    throw new Error('检查点缺失');
  };
  await assert.rejects(requestImageResume(request, 12), /检查点缺失/);
  assert.deepEqual(writes, [{ url: '/api/control-plane/v1/tasks/12/retry', body: { useLatestConfig: false } }]);
});
