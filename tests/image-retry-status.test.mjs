import assert from 'node:assert/strict';
import test from 'node:test';
import { IMAGE_RETRY_EXHAUSTED_LABEL, isImageRetryExhausted } from '../src/control-plane/image-retry-status.mjs';

test('only exhausted image retries in copy review display the three-failures status', () => {
  assert.equal(IMAGE_RETRY_EXHAUSTED_LABEL, '生图3次失败');
  assert.equal(isImageRetryExhausted({ state: 'COPY_REVIEW_PENDING', currentStage: 'IMAGE_RETRY_EXHAUSTED' }), true);
  for (const task of [
    { state: 'COPY_REVIEW_PENDING', currentStage: 'COPY_REVIEW_PENDING' },
    { state: 'COPY_REVIEW_PENDING', currentStage: null },
    { state: 'IMAGE_QUEUED', currentStage: 'IMAGE_QUEUED' },
    { state: 'IMAGE_FAILED', currentStage: 'FAILED' },
    { state: 'CANCELLED', currentStage: 'IMAGE_RETRY_EXHAUSTED' },
  ]) assert.equal(isImageRetryExhausted(task), false);
});
