import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeCreateTask,
  normalizeNodeId,
  normalizeProgress,
  redactExecutionError,
} from '../src/domain.mjs';

test('control plane normalizes an executor-owned copy task', () => {
  assert.deepEqual(normalizeCreateTask({
    query: '  租房桌面整理  ',
    input: { category: '家居' },
    imageCount: 4,
  }), {
    query: '租房桌面整理',
    input: { category: '家居' },
    imageCount: 4,
  });
  assert.equal(normalizeNodeId('desktop-a:copy'), 'desktop-a:copy');
});

test('control plane rejects unsafe node identifiers and invalid image counts', () => {
  assert.throws(() => normalizeNodeId('../../server'), /nodeId/u);
  assert.throws(() => normalizeCreateTask({ query: '选题', imageCount: 9 }), /imageCount/u);
});

test('execution progress is bounded and secrets are redacted', () => {
  assert.deepEqual(normalizeProgress({
    stage: 'image_alignment',
    progressPercent: 47,
    message: '第 2 页',
    details: { page: 2 },
  }), {
    stage: 'IMAGE_ALIGNMENT',
    progressPercent: 47,
    message: '第 2 页',
    details: { page: 2 },
  });
  assert.equal(
    redactExecutionError('Bearer abcdefghijklmnop and sk-abcdefghijklmnop'),
    'Bearer [REDACTED_TOKEN] and [REDACTED_API_KEY]',
  );
});
