import assert from 'node:assert/strict';
import test from 'node:test';

import { CREATE_ASSIGNMENT_MODES, createAssignmentFields } from '../src/control-plane/task-assignment.mjs';

test('task creation assignment fields preserve server authority for every role', () => {
  assert.deepEqual(createAssignmentFields({
    role: 'USER', mode: CREATE_ASSIGNMENT_MODES.SELF, assigneeUserId: null,
  }), {});
  assert.deepEqual(createAssignmentFields({
    role: 'ADMIN', mode: CREATE_ASSIGNMENT_MODES.MANUAL, assigneeUserId: ' Alice ',
  }), { assignedToUserId: 'alice' });
  assert.deepEqual(createAssignmentFields({
    role: 'ADMIN', mode: CREATE_ASSIGNMENT_MODES.UNASSIGNED, assigneeUserId: null,
  }), { assignedToUserId: null });
  assert.throws(() => createAssignmentFields({
    role: 'ADMIN', mode: CREATE_ASSIGNMENT_MODES.MANUAL, assigneeUserId: null,
  }), /请选择有效的作业员/u);
  assert.throws(() => createAssignmentFields({
    role: 'ADMIN', mode: CREATE_ASSIGNMENT_MODES.SELF, assigneeUserId: 'admin',
  }), /分配方式/u);
});
