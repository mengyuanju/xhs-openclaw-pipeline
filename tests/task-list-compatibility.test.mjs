import assert from 'node:assert/strict';
import test from 'node:test';

import { isLegacyTaskStateFilterError } from '../app/workbench/task-list-compatibility.ts';

function apiRequestError(status, code, message) {
  const error = new Error(`${message}（${code}）`);
  error.name = 'ApiRequestError';
  error.status = status;
  error.code = code;
  return error;
}

test('legacy task-state validation errors activate the task-list compatibility fallback', () => {
  assert.equal(isLegacyTaskStateFilterError(apiRequestError(
    400,
    'VALIDATION_ERROR',
    'task state filter is invalid',
  )), true);
});

test('unrelated validation and transport errors do not activate the compatibility fallback', () => {
  assert.equal(isLegacyTaskStateFilterError(apiRequestError(
    400,
    'VALIDATION_ERROR',
    'personalScope must be ALL, ASSIGNED or CREATED',
  )), false);
  assert.equal(isLegacyTaskStateFilterError(apiRequestError(
    503,
    'CONTROL_PLANE_UNAVAILABLE',
    '无法连接中心服务',
  )), false);
  assert.equal(isLegacyTaskStateFilterError(new Error('task state filter is invalid')), false);
});
