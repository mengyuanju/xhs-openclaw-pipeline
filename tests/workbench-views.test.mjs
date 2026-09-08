import assert from 'node:assert/strict';
import test from 'node:test';

import { compareTasksByStatePriority, TASK_STATE_PRIORITY, WORKBENCH_VIEWS, matchesWorkbenchView } from '../app/workbench/views.ts';

test('workbench routes include completed work after manual archive', () => {
  assert.deepEqual(WORKBENCH_VIEWS.map((view) => view.label), [
    '个人作业中心', '待分配任务池', '全部文案任务', '待文案审核', '生图中', '人工归档', '已完成', '全部作业',
  ]);
  assert.equal(new Set(WORKBENCH_VIEWS.map((view) => view.href)).size, 8);
  assert.ok(WORKBENCH_VIEWS.every((view) => view.href.startsWith('/workbench/')));
});

test('administrator all jobs includes every task state and historical ownership', () => {
  const all = WORKBENCH_VIEWS.find((view) => view.key === 'ALL_JOBS');
  assert.ok(all);
  assert.equal(all.adminOnly, true);
  for (const state of Object.keys(TASK_STATE_PRIORITY)) {
    for (const assignedToUserId of ['alice', 'bob', null]) {
      assert.equal(matchesWorkbenchView({ state, assignedToUserId }, all, 'admin'), true);
    }
  }
});

test('pending pool exposes every unfinished task that has lost its assignee', () => {
  const pending = WORKBENCH_VIEWS.find((view) => view.key === 'UNASSIGNED');
  assert.ok(pending);
  const unfinished = [
    'COPY_QUEUED', 'COPY_RUNNING', 'COPY_REVIEW_PENDING', 'COPY_FAILED',
    'IMAGE_QUEUED', 'IMAGE_RUNNING', 'IMAGE_FAILED', 'MANUAL_ARCHIVE',
  ];
  assert.deepEqual(pending.states, unfinished);
  for (const state of unfinished) {
    assert.equal(matchesWorkbenchView({ state, assignedToUserId: null }, pending, 'admin'), true);
    assert.equal(matchesWorkbenchView({ state, assignedToUserId: 'alice' }, pending, 'admin'), false);
  }
  for (const state of ['REVIEWED', 'CANCELLED']) {
    assert.equal(matchesWorkbenchView({ state, assignedToUserId: null }, pending, 'admin'), false);
  }
});

test('personal tasks include every active lifecycle state owned by the current user', () => {
  const personal = WORKBENCH_VIEWS[0];
  assert.deepEqual(personal.states, [
    'COPY_QUEUED', 'COPY_RUNNING', 'COPY_REVIEW_PENDING', 'COPY_FAILED',
    'IMAGE_QUEUED', 'IMAGE_RUNNING', 'IMAGE_FAILED', 'MANUAL_ARCHIVE', 'REVIEWED',
  ]);
  const tasks = [
    { id: 1, state: 'COPY_QUEUED', createdByUserId: 'bob', assignedToUserId: 'alice', copyExecutorNodeId: 'other-node' },
    { id: 2, state: 'COPY_REVIEW_PENDING', createdByUserId: 'alice', assignedToUserId: 'alice' },
    { id: 3, state: 'IMAGE_RUNNING', createdByUserId: 'alice', assignedToUserId: 'alice' },
    { id: 4, state: 'MANUAL_ARCHIVE', createdByUserId: 'alice', assignedToUserId: 'alice' },
    { id: 5, state: 'COPY_QUEUED', createdByUserId: 'alice', assignedToUserId: 'bob', copyExecutorNodeId: 'my-node' },
    { id: 6, state: 'COPY_QUEUED', createdByNodeId: 'my-node', assignedToUserId: null },
    { id: 7, state: 'CANCELLED', createdByUserId: 'alice', assignedToUserId: 'alice' },
    { id: 8, state: 'COPY_RUNNING', createdByUserId: 'alice', assignedToUserId: 'alice', copyExecutorNodeId: 'other-node' },
    { id: 9, state: 'COPY_FAILED', createdByUserId: 'alice', assignedToUserId: 'alice' },
    { id: 10, state: 'IMAGE_QUEUED', createdByUserId: 'alice', assignedToUserId: 'alice' },
    { id: 11, state: 'IMAGE_FAILED', createdByUserId: 'alice', assignedToUserId: 'alice' },
    { id: 12, state: 'MANUAL_ARCHIVE', createdByUserId: 'alice', assignedToUserId: 'alice' },
    { id: 13, state: 'COPY_REVIEW_PENDING', currentStage: 'IMAGE_RETRY_EXHAUSTED', createdByUserId: 'alice', assignedToUserId: 'alice' },
    { id: 14, state: 'COPY_RUNNING', createdByUserId: 'bob', assignedToUserId: 'bob' },
    { id: 15, state: 'COPY_FAILED', createdByUserId: 'bob', assignedToUserId: 'bob' },
  ];
  assert.deepEqual(tasks.filter((task) => matchesWorkbenchView(task, personal, 'alice')).map((task) => task.id), [1, 2, 3, 4, 8, 9, 10, 11, 12, 13]);
  assert.deepEqual(tasks.filter((task) => matchesWorkbenchView(task, personal, 'bob')).map((task) => task.id), [5, 14, 15]);
  const allCopy = WORKBENCH_VIEWS.find((view) => view.key === 'ALL_COPY');
  assert.deepEqual(tasks.filter((task) => matchesWorkbenchView(task, allCopy, 'alice')).map((task) => task.id), [1, 5, 6, 8, 9, 14, 15]);
  const unassigned = WORKBENCH_VIEWS.find((view) => view.key === 'UNASSIGNED');
  assert.equal(unassigned.adminOnly, true);
  assert.deepEqual(tasks.filter((task) => matchesWorkbenchView(task, unassigned, 'admin')).map((task) => task.id), [6]);
});

test('task lists prioritize lifecycle state and use newest-first order within a state', () => {
  assert.deepEqual(TASK_STATE_PRIORITY, {
    COPY_REVIEW_PENDING: 1,
    MANUAL_ARCHIVE: 2,
    COPY_RUNNING: 3,
    IMAGE_RUNNING: 4,
    COPY_FAILED: 5,
    IMAGE_FAILED: 5,
    COPY_QUEUED: 6,
    IMAGE_QUEUED: 6,
    REVIEWED: 7,
    CANCELLED: 8,
  });
  const tasks = [
    { id: 1, state: 'MANUAL_ARCHIVE', createdAt: '2026-09-05T12:00:00.000Z' },
    { id: 2, state: 'COPY_REVIEW_PENDING', createdAt: '2026-09-05T08:00:00.000Z' },
    { id: 3, state: 'COPY_RUNNING', createdAt: '2026-09-05T13:00:00.000Z' },
    { id: 4, state: 'COPY_REVIEW_PENDING', createdAt: '2026-09-05T10:00:00.000Z' },
    { id: 5, state: 'IMAGE_RUNNING', createdAt: '2026-09-05T14:00:00.000Z' },
    { id: 6, state: 'COPY_FAILED', createdAt: '2026-09-05T15:00:00.000Z' },
    { id: 7, state: 'IMAGE_QUEUED', createdAt: '2026-09-05T16:00:00.000Z' },
  ];
  assert.deepEqual(tasks.sort(compareTasksByStatePriority).map((task) => task.id), [4, 2, 1, 3, 5, 6, 7]);
});

test('only approved images enter completed work and remain visible to their creator', () => {
  const completed = WORKBENCH_VIEWS.find((view) => view.key === 'COMPLETED');
  assert.ok(completed);
  assert.equal(completed.href, '/workbench/completed');
  for (const state of Object.keys(TASK_STATE_PRIORITY)) {
    assert.equal(matchesWorkbenchView({ state }, completed, 'reviewer'), state === 'REVIEWED');
  }
  assert.equal(matchesWorkbenchView({ state: 'REVIEWED', assignedToUserId: 'alice' }, WORKBENCH_VIEWS[0], 'alice'), true);
});
