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

test('ordinary task creation defers assignment until copy review and skip-review requires an owner', async () => {
  const [workbench, picker, assignment] = await Promise.all([
    source('app/workbench/creation-workbench.tsx'),
    source('app/workbench/job-user-picker.tsx'),
    source('src/control-plane/task-assignment.mjs'),
  ]);
  assert.doesNotMatch(workbench, /CreateAssignmentMode|createAssignmentMode/u);
  assert.match(workbench, /const \[skipCopyReview, setSkipCopyReview\] = useState\(false\)/u);
  assert.match(workbench, /setSkipCopyReview\(false\)/u);
  assert.match(workbench, /setCreateAssignee\(null\)/u);
  assert.match(workbench, /createAssignmentFields/u);
  assert.match(workbench, /mode: effectiveSkipCopyReview \? CREATE_ASSIGNMENT_MODES\.MANUAL : CREATE_ASSIGNMENT_MODES\.UNASSIGNED/u);
  assert.match(workbench, /\.\.\.assignmentFields/u);
  assert.match(workbench, /skipCopyReview: effectiveSkipCopyReview/u);
  assert.match(workbench, /文案完成后再分配审核负责人/u);
  assert.match(workbench, /免审任务不会经过文案派单节点，因此必须现在明确指定负责人/u);
  assert.match(workbench, /effectiveSkipCopyReview && !createAssignee/u);
  assert.match(workbench, /allowEmptyOption=\{false\}/u);
  assert.match(workbench, /additionallyEligibleUserIds=\{\[creatorAccountId\]\}/u);
  assert.match(workbench, /const copyReviewBypassAllowed = role === 'ADMIN'/u);
  assert.match(workbench, /disabled=\{creating \|\| !copyReviewBypassAllowed\}/u);
  assert.match(picker, /eligibleRoles\.includes\(user\.role\) \|\| additionallyEligibleUserIds\.includes/u);
  assert.match(picker, /user\.status === 'ACTIVE'/u);
  assert.match(picker, /allowEmptyOption && value && <Button/u);
  assert.doesNotMatch(workbench, /assignmentSource\s*:/u);
  assert.match(assignment, /if \(role !== 'ADMIN'\) return \{\}/u);
});

test('pending-assignment is review-only while personal view includes submitted and assigned tasks', async () => {
  const workbench = await source('app/workbench/creation-workbench.tsx');
  const pending = WORKBENCH_VIEWS.find((view) => view.key === 'UNASSIGNED');
  const personal = WORKBENCH_VIEWS.find((view) => view.key === 'PERSONAL');
  assert.ok(pending && personal);
  assert.equal(pending.href, '/workbench/unassigned');
  assert.equal(pending.adminOnly, true);
  assert.equal(pending.label, '待审核分配');
  assert.equal(matchesWorkbenchView({ state: 'COPY_QUEUED', assignedToUserId: null }, pending, 'admin'), false);
  assert.equal(matchesWorkbenchView({ state: 'COPY_RUNNING', assignedToUserId: null }, pending, 'admin'), false);
  assert.equal(matchesWorkbenchView({ state: 'COPY_REVIEW_PENDING', assignedToUserId: null }, pending, 'admin'), true);
  assert.equal(matchesWorkbenchView({ state: 'COPY_FAILED', assignedToUserId: null }, pending, 'admin'), false);
  assert.equal(matchesWorkbenchView({ state: 'COPY_QUEUED', assignedToUserId: 'alice' }, pending, 'admin'), false);
  assert.equal(matchesWorkbenchView({ state: 'COPY_QUEUED', createdByUserId: 'admin', assignedToUserId: 'alice' }, personal, 'alice'), true);
  assert.equal(matchesWorkbenchView({ state: 'COPY_QUEUED', createdByUserId: 'alice', createdByAccountId: 7, assignedToUserId: 'bob' }, personal, 'alice', 7), true);
  assert.equal(matchesWorkbenchView({ state: 'COPY_QUEUED', createdByUserId: 'alice', createdByAccountId: 8, assignedToUserId: 'bob' }, personal, 'alice', 7), false);
  assert.equal(matchesWorkbenchView({ state: 'COPY_QUEUED', createdByUserId: 'bob', assignedToUserId: 'alice',
    assignedToAccountId: 8 }, personal, 'alice', 7), false);
  assert.match(workbench, /view\.unassignedOnly\) search\.set\('unassigned', 'true'\)/u);
  assert.match(workbench, /function isPersonalTask/u);
  assert.match(workbench, /function isTaskAssignee/u);
  assert.match(workbench, /task\.createdByAccountId === accountId/u);
  assert.match(workbench, /task\.assignedToAccountId === accountId/u);
  assert.match(workbench, /assignedToDisplayName/u);
  assert.match(workbench, /创建：\{task\.createdByDisplayName/u);
  assert.match(workbench, /\['COPY_QUEUED', 'COPY_RUNNING'\]\.includes\(task\.state\)\) return '尚未到派单节点'/u);
  assert.match(workbench, /task\.state === 'COPY_REVIEW_PENDING'\) return '待分配'/u);
  assert.match(workbench, /return '等待文案执行机领取'/u);
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
  const singleRequestStart = dialog.indexOf('`/api/control-plane/v1/tasks/${tasks[0].id}/assignee`');
  const batchRequestStart = dialog.indexOf("'/api/control-plane/v1/tasks/batch-assignee'", singleRequestStart);
  const requestSuccessStart = dialog.indexOf('const destination =', batchRequestStart);
  assert.ok(singleRequestStart >= 0 && batchRequestStart > singleRequestStart
    && requestSuccessStart > batchRequestStart);
  assert.match(dialog.slice(singleRequestStart, batchRequestStart),
    /assignedToAccountId: assignee\?\.id \?\? null/u);
  assert.match(dialog.slice(batchRequestStart, requestSuccessStart),
    /assignedToAccountId: assignee\?\.id \?\? null/u);
  assert.match(dialog, /selectedTasksHaveMixedAssignees\(tasks\)/u);
  assert.match(dialog, /负责人不一致，请重新选择/u);
  assert.match(dialog, /disabled=\{submitting \|\| tasks\.length === 0 \|\| destinationRequired\}/u);
  assert.match(dialog, /additionallyEligibleUserIds=\{\[Number\(currentAdmin\.id\)\]\}/u);
  assert.match(dialog, />我来处理<\/Button>/u);
  assert.match(dialog, /allowEmptyOption=\{canReturnToPool\}/u);
  assert.match(dialog, /task\.skipCopyReview === true && task\.state === 'COPY_QUEUED'/u);
  assert.match(dialog, /!canReturnToPool && current === null/u);
  assert.match(workbench, /setAssignmentTasks\(\[task\]\)/u);
  assert.match(workbench, /setAssignmentTasks\(assignmentEligibleTasks\)/u);
  assert.match(workbench, /setSelectedTaskIds\(\[\]\)/u);
  assert.match(workbench, /currentAdmin=\{currentAdmin\}/u);
  assert.match(proxy, /'\/v1\/tasks\/batch-assignee'/u);
  assert.match(proxy, /assignee\$\//u);
  assert.match(repository, /taskAssignmentVersion: 3/u);
});
