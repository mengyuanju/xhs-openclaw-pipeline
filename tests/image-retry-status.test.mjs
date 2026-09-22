import assert from 'node:assert/strict';
import test from 'node:test';
import {
  IMAGE_RETRY_EXHAUSTED_LABEL,
  imageFailureDisplayReason,
  isImageRetryExhausted,
  latestImageRetryFailures,
} from '../src/control-plane/image-retry-status.mjs';

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

test('the exhausted status exposes the latest three concrete image failures in attempt order', () => {
  const chain = 'current-chain';
  const execution = (attempt, error, startedAt, imageProductionChainId = chain) => ({
    kind: 'IMAGE', status: 'FAILED', stage: 'STARTING_IMAGE', error, startedAt, imageProductionChainId,
    snapshot: attempt === 1 ? {} : { imageRetry: { failedAttempts: attempt - 1 } },
  });
  const failures = latestImageRetryFailures({
    state: 'COPY_REVIEW_PENDING', currentStage: 'IMAGE_RETRY_EXHAUSTED', imageProductionChainId: chain,
    executions: [
      execution(2, 'latest checkpoint missing', '2026-09-22T02:10:45.000Z'),
      execution(1, 'latest title failure', '2026-09-22T02:10:40.000Z'),
      execution(3, 'older checkpoint missing', '2026-09-22T02:00:50.000Z'),
      execution(3, 'latest retry exhausted', '2026-09-22T02:10:50.000Z'),
      execution(1, 'other chain failure', '2026-09-22T02:11:00.000Z', 'other-chain'),
    ],
  });
  assert.deepEqual(failures.map(({ attempt, error }) => ({ attempt, error })), [
    { attempt: 1, error: 'latest title failure' },
    { attempt: 2, error: 'latest checkpoint missing' },
    { attempt: 3, error: 'latest retry exhausted' },
  ]);
});

test('known title validation failures have a readable display reason', () => {
  assert.equal(
    imageFailureDisplayReason('title cannot contain exclamation marks or full-width tildes'),
    '标题包含感叹号（!、！）或全角波浪号（～），不符合标题规则。',
  );
  assert.equal(imageFailureDisplayReason('图片检查点缺失'), '图片检查点缺失');
});
