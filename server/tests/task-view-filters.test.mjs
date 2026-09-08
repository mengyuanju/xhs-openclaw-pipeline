import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeSavedTaskView, normalizeTaskAttention } from '../src/task-view-filters.mjs';

test('saved task views retain only validated list controls', () => {
  assert.deepEqual(normalizeSavedTaskView({
    name: '  我的 失败任务  ',
    viewKey: 'ALL_JOBS',
    filters: {
      query: '超时', deduplicateQuery: true, createdByUserId: 'alice', createdByRole: 'USER',
      state: 'IMAGE_FAILED', sort: 'id:desc', attention: 'FAILED', pageSize: 50,
      taskId: 123, page: 9, unexpected: 'not persisted',
    },
  }), {
    name: '我的 失败任务',
    viewKey: 'ALL_JOBS',
    filters: {
      query: '超时', deduplicateQuery: true, createdByUserId: 'alice', createdByRole: 'USER',
      state: 'IMAGE_FAILED', sort: 'id:desc', attention: 'FAILED', pageSize: 50,
    },
  });
});

test('saved task views reject untrusted filter values', () => {
  assert.equal(normalizeTaskAttention('stale'), 'STALE');
  assert.throws(() => normalizeTaskAttention('EVERYTHING'), /attention/u);
  assert.throws(() => normalizeSavedTaskView({ name: 'x', viewKey: 'ALL_JOBS', filters: { sort: 'query:asc' } }), /sort/u);
  assert.throws(() => normalizeSavedTaskView({ name: 'x', viewKey: 'SECRET', filters: {} }), /page/u);
  assert.throws(() => normalizeSavedTaskView({ name: 'x', viewKey: 'ALL_JOBS', filters: { createdByUserId: '../alice' } }), /createdByUserId/u);
});
