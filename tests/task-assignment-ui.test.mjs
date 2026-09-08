import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { WORKBENCH_VIEWS, matchesWorkbenchView } from '../app/workbench/views.ts';

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('assignment controls reuse the shared UI library instead of native replacements', async () => {
  const files = await Promise.all([
    source('app/workbench/creation-workbench.tsx'),
    source('app/workbench/job-user-picker.tsx'),
    source('app/workbench/task-assignment-dialog.tsx'),
  ]);
  for (const value of files) {
    assert.doesNotMatch(value, /<select(?:\s|>)/u);
    assert.doesNotMatch(value, /<dialog(?:\s|>)/u);
    assert.doesNotMatch(value, /window\.confirm\s*\(/u);
  }
  assert.match(files[1], /from '@\/components\/ui\/dialog'/u);
  assert.match(files[1], /from '@\/components\/ui\/button'/u);
  assert.match(files[1], /<SearchInput/u);
  assert.match(files[2], /<JobUserPicker/u);
  assert.match(files[2], /<Textarea/u);
});

test('task creation never defaults to the first worker and keeps ordinary-user authority on the server', async () => {
  const [workbench, picker, assignment] = await Promise.all([
    source('app/workbench/creation-workbench.tsx'),
    source('app/workbench/job-user-picker.tsx'),
    source('src/control-plane/task-assignment.mjs'),
  ]);
  assert.match(workbench, /useState<CreateAssignmentMode>\('UNASSIGNED'\)/u);
  assert.match(workbench, /setCreateAssignmentMode\('UNASSIGNED'\)/u);
  assert.match(workbench, /setCreateAssignee\(null\)/u);
  assert.match(workbench, /createAssignmentFields/u);
  assert.match(workbench, /\.\.\.assignmentFields/u);
  assert.match(workbench, /指定作业员/u);
  assert.match(workbench, /进入待分配任务池/u);
  assert.match(picker, /eligibleRoles\.includes\(user\.role\)/u);
  assert.match(picker, /user\.status === 'ACTIVE'/u);
  assert.doesNotMatch(workbench, /assignmentSource\s*:/u);
  assert.match(assignment, /if \(role !== 'ADMIN'\) return \{\}/u);
});

test('pending-pool and personal views are based on assignee rather than creator', async () => {
  const workbench = await source('app/workbench/creation-workbench.tsx');
  const pending = WORKBENCH_VIEWS.find((view) => view.key === 'UNASSIGNED');
  const personal = WORKBENCH_VIEWS.find((view) => view.key === 'PERSONAL');
  assert.ok(pending && personal);
  assert.equal(pending.href, '/workbench/unassigned');
  assert.equal(pending.adminOnly, true);
  assert.equal(matchesWorkbenchView({ state: 'COPY_QUEUED', assignedToUserId: null }, pending, 'admin'), true);
  assert.equal(matchesWorkbenchView({ state: 'COPY_QUEUED', assignedToUserId: 'alice' }, pending, 'admin'), false);
  assert.equal(matchesWorkbenchView({ state: 'COPY_QUEUED', createdByUserId: 'admin', assignedToUserId: 'alice' }, personal, 'alice'), true);
  assert.equal(matchesWorkbenchView({ state: 'COPY_QUEUED', createdByUserId: 'alice', assignedToUserId: 'bob' }, personal, 'alice'), false);
  assert.match(workbench, /view\.unassignedOnly\) search\.set\('unassigned', 'true'\)/u);
  assert.match(workbench, /taskOwnerId\(task\) === creatorUserId/u);
  assert.match(workbench, /assignedToDisplayName/u);
  assert.match(workbench, /创建：\{task\.createdByDisplayName/u);
});

test('administrators can assign one task or the current selection through protected proxy routes', async () => {
  const [workbench, dialog, proxy, repository] = await Promise.all([
    source('app/workbench/creation-workbench.tsx'),
    source('app/workbench/task-assignment-dialog.tsx'),
    source('app/api/control-plane/[...path]/route.ts'),
    source('server/src/postgres-repository.mjs'),
  ]);
  assert.match(dialog, /`\/api\/control-plane\/v1\/tasks\/\$\{tasks\[0\]\.id\}\/assignee`/u);
  assert.match(dialog, /method: 'PATCH'/u);
  assert.match(dialog, /\/api\/control-plane\/v1\/tasks\/batch-assignee/u);
  assert.match(dialog, /method: 'POST'/u);
  assert.match(dialog, /taskIds: tasks\.map/u);
  assert.match(workbench, /setAssignmentTasks\(\[task\]\)/u);
  assert.match(workbench, /setAssignmentTasks\(selectedTasks\)/u);
  assert.match(workbench, /setSelectedTaskIds\(\[\]\)/u);
  assert.match(proxy, /'\/v1\/tasks\/batch-assignee'/u);
  assert.match(proxy, /assignee\$\//u);
  assert.match(repository, /taskAssignmentVersion: 1/u);
});
