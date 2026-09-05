import assert from 'node:assert/strict';
import test from 'node:test';

import { compareTasksByStatePriority, TASK_STATE_PRIORITY, WORKBENCH_VIEWS, matchesWorkbenchView } from '../app/workbench/views.ts';

test('workbench routes place all copy directly under the personal list and omit completed', () => {
  assert.deepEqual(WORKBENCH_VIEWS.map((view) => view.label), [
    '个人作业中心', '全部文案任务', '待文案审核', '生图中', '人工归档',
  ]);
  assert.equal(new Set(WORKBENCH_VIEWS.map((view) => view.href)).size, 5);
  assert.ok(WORKBENCH_VIEWS.every((view) => view.href.startsWith('/workbench/')));
});

test('personal tasks include every active lifecycle state owned by the current user', () => {
  const personal = WORKBENCH_VIEWS[0];
  assert.deepEqual(personal.states, [
    'COPY_QUEUED', 'COPY_RUNNING', 'COPY_REVIEW_PENDING', 'COPY_FAILED',
    'IMAGE_QUEUED', 'IMAGE_RUNNING', 'IMAGE_FAILED', 'MANUAL_ARCHIVE',
  ]);
  const tasks = [
    { id: 1, state: 'COPY_QUEUED', createdByUserId: 'alice', copyExecutorNodeId: 'other-node' },
    { id: 2, state: 'COPY_REVIEW_PENDING', createdByUserId: 'alice' },
    { id: 3, state: 'IMAGE_RUNNING', createdByUserId: 'alice' },
    { id: 4, state: 'MANUAL_ARCHIVE', createdByUserId: 'alice' },
    { id: 5, state: 'COPY_QUEUED', createdByUserId: 'bob', copyExecutorNodeId: 'my-node' },
    { id: 6, state: 'COPY_QUEUED', createdByNodeId: 'my-node' },
    { id: 7, state: 'CANCELLED', createdByUserId: 'alice' },
    { id: 8, state: 'COPY_RUNNING', createdByUserId: 'alice', copyExecutorNodeId: 'other-node' },
    { id: 9, state: 'COPY_FAILED', createdByUserId: 'alice' },
    { id: 10, state: 'IMAGE_QUEUED', createdByUserId: 'alice' },
    { id: 11, state: 'IMAGE_FAILED', createdByUserId: 'alice' },
    { id: 12, state: 'MANUAL_ARCHIVE', createdByUserId: 'alice' },
    { id: 13, state: 'COPY_REVIEW_PENDING', currentStage: 'IMAGE_RETRY_EXHAUSTED', createdByUserId: 'alice' },
    { id: 14, state: 'COPY_RUNNING', createdByUserId: 'bob' },
    { id: 15, state: 'COPY_FAILED', createdByUserId: 'bob' },
  ];
  assert.deepEqual(tasks.filter((task) => matchesWorkbenchView(task, personal, 'alice')).map((task) => task.id), [1, 2, 3, 4, 8, 9, 10, 11, 12, 13]);
  assert.deepEqual(tasks.filter((task) => matchesWorkbenchView(task, personal, 'bob')).map((task) => task.id), [5, 14, 15]);
  const allCopy = WORKBENCH_VIEWS[1];
  assert.deepEqual(tasks.filter((task) => matchesWorkbenchView(task, allCopy, 'alice')).map((task) => task.id), [1, 5, 6, 8, 9, 14, 15]);
});

test('task lists prioritize lifecycle state and use newest-first order within a state', () => {
  assert.deepEqual(TASK_STATE_PRIORITY, {
    COPY_REVIEW_PENDING: 1,
    COPY_RUNNING: 2,
    IMAGE_RUNNING: 3,
    COPY_FAILED: 4,
    IMAGE_FAILED: 4,
    COPY_QUEUED: 5,
    IMAGE_QUEUED: 5,
    MANUAL_ARCHIVE: 6,
    CANCELLED: 7,
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
  assert.deepEqual(tasks.sort(compareTasksByStatePriority).map((task) => task.id), [4, 2, 3, 5, 6, 7, 1]);
});
