import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CREATE_ASSIGNMENT_MODES,
  createAssignmentFields,
  selectedTasksHaveMixedAssignees,
} from '../src/control-plane/task-assignment.mjs';

test('task creation assignment fields preserve server authority for every role', () => {
  assert.deepEqual(createAssignmentFields({
    role: 'USER', mode: CREATE_ASSIGNMENT_MODES.SELF, assigneeUserId: null,
  }), {});
  assert.deepEqual(createAssignmentFields({
    role: 'ADMIN', mode: CREATE_ASSIGNMENT_MODES.MANUAL, assigneeUserId: ' Alice ', assigneeAccountId: 27,
  }), { assignedToUserId: 'alice', assignedToAccountId: 27 });
  assert.deepEqual(createAssignmentFields({
    role: 'ADMIN', mode: CREATE_ASSIGNMENT_MODES.UNASSIGNED, assigneeUserId: null,
  }), { assignedToUserId: null, assignedToAccountId: null });
  assert.throws(() => createAssignmentFields({
    role: 'ADMIN', mode: CREATE_ASSIGNMENT_MODES.MANUAL, assigneeUserId: null,
  }), /请选择有效的作业员/u);
  assert.throws(() => createAssignmentFields({
    role: 'ADMIN', mode: CREATE_ASSIGNMENT_MODES.MANUAL, assigneeUserId: 'alice', assigneeAccountId: null,
  }), /作业员账号/u);
  assert.throws(() => createAssignmentFields({
    role: 'ADMIN', mode: CREATE_ASSIGNMENT_MODES.SELF, assigneeUserId: 'admin',
  }), /分配方式/u);
});

test('batch assignment distinguishes mixed owners from an explicitly unassigned selection', () => {
  assert.equal(selectedTasksHaveMixedAssignees([]), false);
  assert.equal(selectedTasksHaveMixedAssignees([
    { assignedToUserId: null },
    { assignedToUserId: null },
  ]), false);
  assert.equal(selectedTasksHaveMixedAssignees([
    { assignedToUserId: 'alice' },
    { assignedToUserId: 'alice' },
  ]), false);
  assert.equal(selectedTasksHaveMixedAssignees([
    { assignedToUserId: 'alice', assignedToAccountId: 2 },
    { assignedToUserId: 'alice', assignedToAccountId: 9 },
  ]), true);
  assert.equal(selectedTasksHaveMixedAssignees([
    { assignedToUserId: 'alice' },
    { assignedToUserId: 'bob' },
  ]), true);
  assert.equal(selectedTasksHaveMixedAssignees([
    { assignedToUserId: null },
    { assignedToUserId: 'alice' },
  ]), true);
});
