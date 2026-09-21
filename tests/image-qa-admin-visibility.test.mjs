import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeImageQaItem } from '../app/image-qa/types.ts';

const rawItem = {
  id: '71717171-7171-4717-8717-717171717171',
  freezePublicId: '81818181-8181-4818-8818-818181818181',
  anonymousCode: 'IQ-ABCDEF123456',
  status: 'PENDING',
  sampleKind: 'RANDOM',
  blindReview: true,
  assets: [{
    id: 12,
    mediaType: 'image/png',
    sha256: 'a'.repeat(64),
    originalName: '01.png',
    pageIndex: 1,
    url: '/v1/image-qa/items/item/assets/12',
  }],
  capabilities: { canPass: true, canReturnSingle: true, canReturnBatch: false },
  blockers: { pendingImageEdits: 0 },
  taskId: 991,
  query: '玄关收纳',
  productionBatch: { id: 27, queryPackageName: '九月选题' },
  submitter: { accountId: 64, username: 'worker' },
  imageRunId: 'image-run-1',
  copyRevisionId: 902,
};

test('image QA keeps administrators in a full-information view under blind configuration', () => {
  const item = normalizeImageQaItem(rawItem, 'ADMIN');
  assert.ok(item && !item.blindReview);
  assert.equal(item.taskId, 991);
  assert.equal(item.query, '玄关收纳');
  assert.equal(item.productionBatch.queryPackageName, '九月选题');
  assert.equal(item.submitter.username, 'worker');
  assert.equal(item.imageRunId, 'image-run-1');
  assert.equal(item.copyRevisionId, 902);
});

test('image QA still strips provenance from reviewer state under blind configuration', () => {
  const item = normalizeImageQaItem(rawItem, 'REVIEWER');
  assert.ok(item?.blindReview);
  for (const key of ['taskId', 'query', 'productionBatch', 'submitter', 'imageRunId', 'copyRevisionId']) {
    assert.equal(Object.hasOwn(item, key), false, key);
  }
});
