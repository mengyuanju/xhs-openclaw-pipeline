import assert from 'node:assert/strict';
import test from 'node:test';

import { loadMigrations } from '../src/database-migrations.mjs';
import {
  TASK_ASSIGNMENT_SOURCES,
  normalizeAssigneeUserId,
  normalizeAssignmentSource,
} from '../src/task-assignment-domain.mjs';

test('task assignment identifiers are optional only when explicitly permitted', () => {
  assert.equal(normalizeAssigneeUserId(null), null);
  assert.equal(normalizeAssigneeUserId('  Alice.Worker  '), 'alice.worker');
  assert.throws(() => normalizeAssigneeUserId(null, { allowNull: false }), /required/u);
  for (const value of ['ab', 'with space', 'a'.repeat(51), 42]) {
    assert.throws(() => normalizeAssigneeUserId(value));
  }
});

test('task assignment sources use one bounded vocabulary', () => {
  assert.deepEqual(TASK_ASSIGNMENT_SOURCES, ['SELF', 'MANUAL', 'AUTO']);
  assert.equal(normalizeAssignmentSource('manual'), 'MANUAL');
  assert.throws(() => normalizeAssignmentSource('imported'));
});

test('task assignment migration separates assignee from creator without deleting history', async () => {
  const migration = (await loadMigrations()).find((item) => item.id === '0017_task_assignment');
  assert.ok(migration);
  assert.match(migration.sql, /assigned_to_user_id varchar\(50\)[\s\S]*ON DELETE SET NULL/u);
  assert.match(migration.sql, /assignment_source[\s\S]*'SELF'[\s\S]*'MANUAL'[\s\S]*'AUTO'/u);
  assert.match(migration.sql, /creator\.role = 'USER'/u);
  assert.match(migration.sql, /creator\.status = 'ACTIVE'/u);
  assert.match(migration.sql, /tasks_unassigned_copy_queue_idx/u);
  assert.match(migration.sql, /CREATE TABLE IF NOT EXISTS task_assignment_events/u);
  assert.match(migration.sql, /'PERSONAL', 'UNASSIGNED', 'ALL_COPY'/u);
  assert.doesNotMatch(migration.sql, /DELETE FROM|TRUNCATE|DROP TABLE/u);
});
