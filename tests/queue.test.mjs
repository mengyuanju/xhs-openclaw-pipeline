import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { createQueue } from '../src/queue.mjs';

const queues = [];

function makeQueue() {
  const queue = createQueue(':memory:');
  queues.push(queue);
  return queue;
}

afterEach(() => {
  while (queues.length > 0) {
    queues.pop().close();
  }
});

describe('task queue', () => {
  it('rejects blank and oversized queries at the boundary', () => {
    const queue = makeQueue();

    assert.throws(() => queue.enqueue({ query: '   ' }), /query.*empty/i);
    assert.throws(() => queue.enqueue({ query: '桌'.repeat(501) }), /query.*500/i);
  });

  it('enqueues a trimmed query in pending state', () => {
    const queue = makeQueue();

    const task = queue.enqueue({
      query: '  租房桌面怎么整理？  ',
      input: { platform: 'xiaohongshu' },
    });

    assert.equal(task.id, 1);
    assert.equal(task.query, '租房桌面怎么整理？');
    assert.equal(task.status, 'pending');
    assert.deepEqual(task.input, { platform: 'xiaohongshu' });
    assert.equal(task.attempts, 0);
  });

  it('claims the oldest task once and records a lease', () => {
    const queue = makeQueue();
    queue.enqueue({ query: '任务一' });
    queue.enqueue({ query: '任务二' });
    const now = new Date('2026-08-15T01:00:00.000Z');

    const claimed = queue.claimNext({ workerId: 'worker-a', leaseMs: 60_000, now });
    const next = queue.claimNext({ workerId: 'worker-b', leaseMs: 60_000, now });

    assert.equal(claimed.id, 1);
    assert.equal(claimed.status, 'processing');
    assert.equal(claimed.leaseOwner, 'worker-a');
    assert.equal(claimed.leaseUntil, '2026-08-15T01:01:00.000Z');
    assert.equal(claimed.attempts, 1);
    assert.equal(next.id, 2);
  });

  it('reclaims a processing task after its lease expires', () => {
    const queue = makeQueue();
    queue.enqueue({ query: '会过期的任务' });
    queue.claimNext({
      workerId: 'worker-a',
      leaseMs: 1_000,
      now: new Date('2026-08-15T01:00:00.000Z'),
    });

    const reclaimed = queue.claimNext({
      workerId: 'worker-b',
      leaseMs: 10_000,
      now: new Date('2026-08-15T01:00:02.000Z'),
    });

    assert.equal(reclaimed.id, 1);
    assert.equal(reclaimed.leaseOwner, 'worker-b');
    assert.equal(reclaimed.attempts, 2);
  });

  it('completes only the task held by the same worker', () => {
    const queue = makeQueue();
    queue.enqueue({ query: '待完成任务' });
    const task = queue.claimNext({ workerId: 'worker-a' });

    assert.throws(
      () => queue.complete(task.id, { workerId: 'worker-b', outputDir: 'output/1' }),
      /lease owner/i,
    );

    const completed = queue.complete(task.id, {
      workerId: 'worker-a',
      outputDir: 'output/1',
    });

    assert.equal(completed.status, 'completed');
    assert.equal(completed.outputDir, 'output/1');
    assert.equal(completed.leaseOwner, null);
  });

  it('records a bounded failure without losing the task', () => {
    const queue = makeQueue();
    queue.enqueue({ query: '失败任务' });
    const task = queue.claimNext({ workerId: 'worker-a' });

    const failed = queue.fail(task.id, {
      workerId: 'worker-a',
      error: `模型失败：${'x'.repeat(3_000)}`,
    });

    assert.equal(failed.status, 'failed');
    assert.equal(failed.error.length, 2_000);
    assert.equal(failed.leaseOwner, null);
    assert.deepEqual(queue.countByStatus(), {
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 1,
    });
  });
});
