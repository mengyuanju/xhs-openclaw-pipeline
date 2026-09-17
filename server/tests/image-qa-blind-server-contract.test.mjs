import assert from 'node:assert/strict';
import test from 'node:test';

import { imageQaItemFrom } from '../src/image-quality-control.mjs';

function databaseRow() {
  return {
    public_id: '71717171-7171-4717-8717-717171717171',
    freeze_public_id: '81818181-8181-4818-8818-818181818181',
    status: 'PENDING',
    sample_kind: 'RANDOM',
    blind_review_enabled: true,
    selected: true,
    task_id: 991,
    query: '玄关收纳',
    production_batch_id: 27,
    query_package_name: '九月选题',
    submitter_account_id: 64,
    submitter_username: 'worker',
    assigned_review_account_id: 91,
    image_run_id: 'image-run-1',
    copy_revision_id: 902,
    priority_paused: false,
    image_reviewer_batch_return_enabled: true,
    pending_image_edit_count: 0,
    assets: [{ id: 12, media_type: 'image/png', sha256: 'a'.repeat(64), original_name: '01.png', page_index: 1 }],
  };
}

test('image QA server ignores blind redaction for administrators only', () => {
  const row = databaseRow();
  const admin = imageQaItemFrom(row, { userId: 1, username: 'admin', role: 'ADMIN' });
  const reviewer = imageQaItemFrom(row, { userId: 91, username: 'reviewer', role: 'REVIEWER' });

  assert.equal(admin.blindReview, false);
  assert.equal(admin.taskId, 991);
  assert.equal(admin.query, '玄关收纳');
  assert.equal(admin.productionBatch.queryPackageName, '九月选题');
  assert.equal(admin.submitter.username, 'worker');

  assert.equal(reviewer.blindReview, true);
  for (const key of ['taskId', 'query', 'productionBatch', 'submitter', 'imageRunId', 'copyRevisionId']) {
    assert.equal(Object.hasOwn(reviewer, key), false, key);
  }
});
