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
    assert.equal(task.recoveryAttempts, 0);
    assert.equal(task.recoveryTotalAttempts, 0);
    assert.equal(task.recoveryClass, null);
    assert.equal(task.nextAttemptAt, null);
    assert.equal(task.manualRequired, false);
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
    assert.equal(claimed.processingStartedAt, '2026-08-15T01:00:00.000Z');
    assert.equal(claimed.finishedAt, null);
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

  it('renews only the lease held by the same worker without incrementing attempts', () => {
    const queue = makeQueue();
    queue.enqueue({ query: '需要长时间生成的任务' });
    const claimed = queue.claimNext({
      workerId: 'worker-a',
      leaseMs: 60_000,
      now: new Date('2026-08-25T01:00:00.000Z'),
    });

    assert.throws(
      () => queue.renewLease(claimed.id, {
        workerId: 'worker-b',
        leaseMs: 120_000,
        now: new Date('2026-08-25T01:00:30.000Z'),
      }),
      /lease owner/iu,
    );
    const renewed = queue.renewLease(claimed.id, {
      workerId: 'worker-a',
      leaseMs: 120_000,
      now: new Date('2026-08-25T01:00:30.000Z'),
    });

    assert.equal(renewed.leaseUntil, '2026-08-25T01:02:30.000Z');
    assert.equal(renewed.updatedAt, '2026-08-25T01:00:30.000Z');
    assert.equal(renewed.attempts, 1);
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
      now: new Date('2026-08-15T01:12:34.000Z'),
    });

    assert.equal(completed.status, 'completed');
    assert.equal(completed.outputDir, 'output/1');
    assert.equal(completed.leaseOwner, null);
    assert.equal(completed.finishedAt, '2026-08-15T01:12:34.000Z');
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
    assert.equal(failed.manualRequired, true);
    assert.deepEqual(queue.countByStatus(), {
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 1,
    });
  });

  it('persists a delayed retry and only reclaims it after the backoff expires', () => {
    const queue = makeQueue();
    queue.enqueue({ query: '瞬时故障后自动恢复的任务' });
    const claimed = queue.claimNext({
      workerId: 'worker-a',
      now: new Date('2026-08-29T01:00:00.000Z'),
    });

    const scheduled = queue.scheduleRetry(claimed.id, {
      workerId: 'worker-a',
      error: 'fetch failed: ECONNRESET',
      failureClass: 'TRANSIENT',
      delayMs: 15_000,
      now: new Date('2026-08-29T01:00:01.000Z'),
    });

    assert.equal(scheduled.status, 'pending');
    assert.equal(scheduled.recoveryAttempts, 1);
    assert.equal(scheduled.recoveryTotalAttempts, 1);
    assert.equal(scheduled.recoveryClass, 'TRANSIENT');
    assert.equal(scheduled.nextAttemptAt, '2026-08-29T01:00:16.000Z');
    assert.equal(scheduled.manualRequired, false);
    assert.equal(queue.claimNext({
      workerId: 'worker-b',
      now: new Date('2026-08-29T01:00:15.999Z'),
    }), null);
    assert.equal(queue.nextClaimDelayMs({
      now: new Date('2026-08-29T01:00:15.000Z'),
    }), 1_000);

    const retried = queue.claimNext({
      workerId: 'worker-b',
      now: new Date('2026-08-29T01:00:16.000Z'),
    });
    assert.equal(retried.id, claimed.id);
    assert.equal(retried.attempts, 2);
    assert.equal(retried.nextAttemptAt, null);
  });

  it('tracks consecutive and total recovery attempts separately', () => {
    const queue = makeQueue();
    queue.enqueue({ query: '跨错误类型恢复的任务' });
    let task = queue.claimNext({ workerId: 'worker-a' });
    queue.scheduleRetry(task.id, {
      workerId: 'worker-a', error: 'transport', failureClass: 'TRANSIENT', delayMs: 0,
    });
    task = queue.claimNext({ workerId: 'worker-a' });
    queue.scheduleRetry(task.id, {
      workerId: 'worker-a', error: 'transport again', failureClass: 'TRANSIENT', delayMs: 0,
    });
    task = queue.claimNext({ workerId: 'worker-a' });
    const changedClass = queue.scheduleRetry(task.id, {
      workerId: 'worker-a', error: 'quality', failureClass: 'QUALITY', delayMs: 0,
    });

    assert.equal(changedClass.recoveryAttempts, 1);
    assert.equal(changedClass.recoveryTotalAttempts, 3);
    assert.equal(changedClass.recoveryClass, 'QUALITY');
  });

  it('persists and clears the authentication circuit breaker', () => {
    const queue = makeQueue();
    const opened = queue.openCircuit('openclaw-auth', {
      reason: '401 token_invalidated',
      now: new Date('2026-08-29T02:00:00.000Z'),
    });

    assert.equal(opened.status, 'OPEN');
    assert.equal(opened.openedAt, '2026-08-29T02:00:00.000Z');
    assert.equal(queue.getCircuit('openclaw-auth').reason, '401 token_invalidated');
    assert.equal(queue.closeCircuit('openclaw-auth', {
      now: new Date('2026-08-29T02:05:00.000Z'),
    }).status, 'CLOSED');
    assert.equal(queue.getCircuit('openclaw-auth').status, 'CLOSED');
  });

  it('requeues only failed tasks without erasing the attempt counter', () => {
    const queue = makeQueue();
    const task = queue.enqueue({ query: '需要重试的任务' });
    const claimed = queue.claimNext({ workerId: 'worker-a' });
    queue.fail(claimed.id, { workerId: 'worker-a', error: 'temporary failure' });

    const retried = queue.retry(task.id);
    assert.equal(retried.status, 'pending');
    assert.equal(retried.attempts, 1);
    assert.equal(retried.error, null);
    assert.equal(retried.processingStartedAt, null);
    assert.equal(retried.finishedAt, null);
    assert.equal(retried.recoveryAttempts, 0);
    assert.equal(retried.recoveryTotalAttempts, 0);
    assert.equal(retried.recoveryClass, null);
    assert.equal(retried.nextAttemptAt, null);
    assert.equal(retried.manualRequired, false);
    assert.throws(() => queue.retry(task.id), /only failed tasks/i);
  });
});
