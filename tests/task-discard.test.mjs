import assert from 'node:assert/strict';
import test from 'node:test';
import { canAdminDiscardTask } from '../src/control-plane/task-discard.mjs';

test('administrative discard accepts queued and ordinary pending review tasks regardless of owner', () => {
  for (const state of ['COPY_QUEUED', 'IMAGE_QUEUED', 'COPY_REVIEW_PENDING']) {
    for (const assignedToUserId of [null, 'other-worker']) {
      assert.equal(canAdminDiscardTask({ state, assignedToUserId }), true);
    }
  }
  for (const mandatoryCopyQcOrigin of ['DISCARD_RESTORE', 'SECOND_ASSIGNMENT']) {
    assert.equal(canAdminDiscardTask({ state: 'COPY_REVIEW_PENDING', mandatoryCopyQc: true, mandatoryCopyQcOrigin }), true);
  }
});

test('administrative discard keeps frozen and returned quality work in its disposal flow', () => {
  for (const state of ['COPY_QC_PENDING', 'COPY_RUNNING', 'IMAGE_RUNNING', 'MANUAL_ARCHIVE', 'IMAGE_REWORK_PENDING', 'REVIEWED', 'CANCELLED']) {
    assert.equal(canAdminDiscardTask({ state }), false);
  }
  assert.equal(canAdminDiscardTask({ state: 'COPY_REVIEW_PENDING', mandatoryCopyQcOrigin: 'QA_RETURN' }), false);
  assert.equal(canAdminDiscardTask({ state: 'COPY_REVIEW_PENDING', copyQaReworkPending: true }), false);
  assert.equal(canAdminDiscardTask(null), false);
});
