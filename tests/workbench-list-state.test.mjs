import assert from 'node:assert/strict';
import test from 'node:test';

import { parseWorkbenchListState, workbenchListSearch } from '../app/workbench/list-state.ts';

test('workbench list state safely round-trips filters and sorting through the URL', () => {
  const parsed = parseWorkbenchListState({
    page: '3', pageSize: '50', query: '  #42 ', queryPackageName: '  九月   选题  ', sort: 'createdAt:asc', deduplicateQuery: '1',
    createdByUserId: 'alice', createdByAccountId: '2', createdByRole: 'USER', state: 'IMAGE_FAILED', attention: 'FAILED', taskId: '99',
  }, { allowAdminFilters: true });
  assert.deepEqual(parsed, {
    page: 3, pageSize: 50, query: '#42', queryPackageName: '九月 选题', sort: 'createdAt:asc', deduplicateQuery: true,
    createdByUserId: 'alice', createdByAccountId: 2, createdByRole: 'USER', state: 'IMAGE_FAILED', attention: 'FAILED', taskId: 99,
  });
  assert.equal(workbenchListSearch(parsed, { includeAdminFilters: true }).toString(),
    'page=3&pageSize=50&query=%2342&queryPackageName=%E4%B9%9D%E6%9C%88+%E9%80%89%E9%A2%98&sort=createdAt%3Aasc&deduplicateQuery=1&state=IMAGE_FAILED&createdByUserId=alice&createdByAccountId=2&createdByRole=USER&attention=FAILED&taskId=99');
});

test('workbench URL parsing drops invalid and unauthorized administrator filters', () => {
  const parsed = parseWorkbenchListState({
    page: '-2', pageSize: '1000', sort: 'query:asc', createdByUserId: '../admin',
    createdByRole: 'SUPERADMIN', state: 'NOT_REAL', attention: 'STALE', taskId: 'nope',
  });
  assert.equal(parsed.page, 1);
  assert.equal(parsed.pageSize, 20);
  assert.equal(parsed.queryPackageName, '');
  assert.equal(parsed.sort, 'priority:desc');
  assert.equal(parsed.createdByUserId, '');
  assert.equal(parsed.createdByAccountId, null);
  assert.equal(parsed.createdByRole, 'ALL');
  assert.equal(parsed.state, 'ALL');
  assert.equal(parsed.attention, 'NONE');
  assert.equal(parsed.taskId, null);
});

test('workbench URLs drop a creator name or account id when its identity pair is incomplete', () => {
  assert.equal(parseWorkbenchListState({ createdByUserId: 'alice' }, { allowAdminFilters: true }).createdByUserId, '');
  assert.equal(parseWorkbenchListState({ createdByAccountId: '2' }, { allowAdminFilters: true }).createdByAccountId, null);
});
