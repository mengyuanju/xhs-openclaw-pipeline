import assert from 'node:assert/strict';
import test from 'node:test';

import { WORKBENCH_VIEWS, matchesWorkbenchView } from '../app/workbench/views.ts';

test('each workbench list has its own route and all copy tasks is last', () => {
  assert.deepEqual(WORKBENCH_VIEWS.map((view) => view.label), [
    '个人作业中心', '待文案审核', '生图中', '图文待审核', '已完成', '全部文案任务',
  ]);
  assert.equal(new Set(WORKBENCH_VIEWS.map((view) => view.href)).size, 6);
  assert.ok(WORKBENCH_VIEWS.every((view) => view.href.startsWith('/workbench/')));
});

test('personal tasks include only their creator\'s queued, running and failed copy work', () => {
  const personal = WORKBENCH_VIEWS[0];
  assert.deepEqual(personal.states, ['COPY_QUEUED', 'COPY_RUNNING', 'COPY_FAILED']);
  const tasks = [
    { id: 1, state: 'COPY_QUEUED', createdByUserId: 'alice', copyExecutorNodeId: 'other-node' },
    { id: 2, state: 'COPY_REVIEW_PENDING', createdByUserId: 'alice' },
    { id: 3, state: 'IMAGE_RUNNING', createdByUserId: 'alice' },
    { id: 4, state: 'COMPLETED', createdByUserId: 'alice' },
    { id: 5, state: 'COPY_QUEUED', createdByUserId: 'bob', copyExecutorNodeId: 'my-node' },
    { id: 6, state: 'COPY_QUEUED', createdByNodeId: 'my-node' },
    { id: 7, state: 'CANCELLED', createdByUserId: 'alice' },
    { id: 8, state: 'COPY_RUNNING', createdByUserId: 'alice', copyExecutorNodeId: 'other-node' },
    { id: 9, state: 'COPY_FAILED', createdByUserId: 'alice' },
    { id: 10, state: 'IMAGE_QUEUED', createdByUserId: 'alice' },
    { id: 11, state: 'IMAGE_FAILED', createdByUserId: 'alice' },
    { id: 12, state: 'DELIVERY_REVIEW_PENDING', createdByUserId: 'alice' },
    { id: 13, state: 'COPY_REVIEW_PENDING', currentStage: 'IMAGE_RETRY_EXHAUSTED', createdByUserId: 'alice' },
    { id: 14, state: 'COPY_RUNNING', createdByUserId: 'bob' },
    { id: 15, state: 'COPY_FAILED', createdByUserId: 'bob' },
  ];
  assert.deepEqual(tasks.filter((task) => matchesWorkbenchView(task, personal, 'alice')).map((task) => task.id), [1, 8, 9]);
  assert.deepEqual(tasks.filter((task) => matchesWorkbenchView(task, personal, 'bob')).map((task) => task.id), [5, 14, 15]);
  const allCopy = WORKBENCH_VIEWS.at(-1);
  assert.deepEqual(tasks.filter((task) => matchesWorkbenchView(task, allCopy, 'alice')).map((task) => task.id), [1, 5, 6, 8, 9, 14, 15]);
});
