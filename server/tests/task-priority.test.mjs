import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { SYSTEM_PRIORITY, MANUAL_PRIORITY, systemPriority, priorityFrom, priorityOrderSql, taskLoad, normalizePriorityMode } from '../src/task-priority.mjs';
import { planAutoAssignments } from '../src/task-auto-assignment-runner.mjs';
import { adjustTaskPriority, priorityEvidenceHash } from '../src/task-priority-store.mjs';

test('system priorities consume workflow/rework metadata, with no task-id inference', () => {
  assert.equal(systemPriority(), 100);
  assert.equal(systemPriority({ requeueReason: 'AUTO_RECOVERY' }), 150);
  assert.equal(systemPriority({ requeueReason: 'MANUAL_RETRY' }), 200);
  assert.equal(systemPriority({ reworkCount: 1, requeueReason: 'MANUAL_RETRY' }), 300);
  assert.equal(systemPriority({ requeueReason: 'IMAGE_REVIEW_RETURN' }), 300);
  assert.equal(systemPriority({ reworkCount: 2 }), 400);
  assert.equal(systemPriority({ mandatoryCopyQc: true }), 400);
  assert.equal(systemPriority({ requeueReason: 'toString' }), 100);
  assert.throws(() => normalizePriorityMode('constructor'), /invalid/);
  assert.throws(() => priorityOrderSql('tasks; DELETE'), /invalid/);
});

test('audit evidence hashing tolerates JSONB key reordering and detects changed reasons', () => {
  const first = { taskId: 1, reason: 'deadline', scope: { taskIds: [1,2], version: 1 } };
  const reordered = { scope: { version: 1, taskIds: [1,2] }, reason: 'deadline', taskId: 1 };
  assert.equal(priorityEvidenceHash(first), priorityEvidenceHash(reordered));
  assert.notEqual(priorityEvidenceHash(first), priorityEvidenceHash({ ...first, reason: 'changed' }));
});

test('manual override, system source, pause and waiting compensation remain separately explainable', () => {
  const entered = new Date('2026-09-14T00:00:00Z');
  const fields = priorityFrom({ system_priority: 400, manual_priority: 10, priority_mode: 'DEFER', queue_entered_at: entered }, +entered + 3_600_000);
  assert.equal(fields.systemPriority, 400);
  assert.equal(fields.manualPriority, 10);
  assert.equal(fields.effectivePriority, 10);
  assert.equal(fields.waitingCompensation, 6);
  assert.equal(fields.prioritySource, 'ADMIN');
  assert.equal(priorityFrom({ system_priority: 400, queue_entered_at: entered }).effectivePriority, 400);
  assert.equal(priorityFrom({ priority_mode: 'PAUSE', priority_paused: true }).prioritySource, 'ADMIN');
});

test('weighted allocation selects the less-burdened worker, updates projected loads, and preserves queue order', () => {
  assert.equal(taskLoad({ effectivePriority: 400, reworkCount: 2, currentExecutionId: 'running' }), 8);
  const assignments = planAutoAssignments({
    workers: [
      { username: 'alice', assignmentLimit: 10, currentTaskCount: 1, weightedLoad: 8, lastAutoEventId: null },
      { username: 'bob', assignmentLimit: 10, currentTaskCount: 3, weightedLoad: 3, lastAutoEventId: 9 },
    ],
    tasks: [{ id: 9, effective_priority: 400, rework_count: 2 }, { id: 1 }],
  });
  assert.deepEqual(assignments, [{ taskId: 9, assignedToUserId: 'bob' }, { taskId: 1, assignedToUserId: 'alice' }]);
});

test('invalid actor, missing reason and stale member version fail before any task mutation', async () => {
  const statements = [];
  const client = { query: async (sql) => {
    statements.push(sql);
    if (sql.startsWith('SELECT * FROM tasks')) return { rows: [
      { id: 1, priority_version: 1 }, { id: 2, priority_version: 2 },
    ] };
    throw new Error('unexpected mutation');
  } };
  const input = { taskIds: [1,2], mode: 'HIGH', reason: 'urgent', expectedVersions: { 1: 1, 2: 1 } };
  await assert.rejects(adjustTaskPriority(client, input, { role: 'USER' }), /administrators/);
  await assert.rejects(adjustTaskPriority(client, { ...input, reason: ' ' }, { role: 'ADMIN' }), /reason/);
  await assert.rejects(adjustTaskPriority(client, input, { role: 'ADMIN' }), { code: 'PRIORITY_VERSION_CONFLICT' });
  assert.equal(statements.some(sql => /UPDATE tasks|INSERT/u.test(sql)), false);
});

test('0050 persists the same policy values, backfills metadata and preserves audit history', async () => {
  const sql = await readFile(new URL('../migrations/0050_queue_priority.sql', import.meta.url), 'utf8');
  for (const value of Object.values(SYSTEM_PRIORITY)) assert.ok(sql.includes(String(value)));
  for (const value of Object.values(MANUAL_PRIORITY).filter(value => value !== null)) assert.ok(sql.includes(String(value)));
  assert.match(sql, /BEFORE UPDATE OR DELETE OR TRUNCATE ON task_priority_events/u);
  assert.match(sql, /NEW\.queue_entered_at - NEW\.effective_priority \* interval '10 minutes'/u);
  assert.doesNotMatch(sql.slice(sql.indexOf('CREATE TABLE task_priority_events'), sql.indexOf('CREATE FUNCTION reject_priority')), /REFERENCES/u);
});
