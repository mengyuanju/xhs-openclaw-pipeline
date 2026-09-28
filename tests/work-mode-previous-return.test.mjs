import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCopyQaItem } from '../app/copy-qa/types.ts';
import { normalizeImageQaItem } from '../app/image-qa/types.ts';

const copyBase = {
  id: '71717171-7171-4717-8717-717171717171',
  freezePublicId: '81818181-8181-4818-8818-818181818181',
  anonymousCode: 'QA-RECHECK', blindReview: true, status: 'PENDING', sampleKind: 'MANDATORY_RECHECK', qaVersion: 2,
  approvedRevision: { content: { copy: { title: '待检文案', body: '正文', tags: [] } }, contentSha256: 'a'.repeat(64), revisionToken: 'a'.repeat(64) },
  productionBatch: { anonymousCode: 'PB-ANON' },
  capabilities: { canPass: true, canReturnSingle: true, canReturnBatch: false },
};

test('blind copy recheck keeps prior reason text without accepting identity metadata', () => {
  const item = normalizeCopyQaItem({ ...copyBase, previousReturn: {
    reasonLabels: ['标题 · 信息不准确', '标题 · 信息不准确', 7], note: '请核对标题数量', returnedAt: '2026-09-23T07:00:00.000Z',
    reviewerUsername: 'SECRET-REVIEWER', taskId: 999,
  } });
  assert.ok(item);
  assert.equal(item.capabilities.canReturnSingle, true, 'V2 rechecks may return again for automatic escalation');
  assert.deepEqual(item.previousReturn, {
    reasonLabels: ['标题 · 信息不准确'], note: '请核对标题数量', returnedAt: '2026-09-23T07:00:00.000Z',
  });
  assert.equal(JSON.stringify(item).includes('SECRET-REVIEWER'), false);
  assert.equal(normalizeCopyQaItem({ ...copyBase, sampleKind: 'RANDOM', previousReturn: { note: '旧原因' } }).previousReturn, undefined);
});

test('blind image recheck keeps prior page numbers and scope without carrying old asset ids', () => {
  const base = { id: '91919191-9191-4919-8919-919191919191', freezePublicId: 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1',
    anonymousCode: 'IQ-RECHECK', blindReview: true, status: 'PENDING', sampleKind: 'MANDATORY_RECHECK',
    assets: [{ id: 21, pageIndex: 2, mediaType: 'image/png', url: '/v1/assets/21' }],
    capabilities: { canPass: true, canReturnSingle: true, canReturnBatch: false }, blockers: { pendingImageEdits: 0 } };
  const item = normalizeImageQaItem({ ...base, previousReturn: {
    reasonLabels: ['文字遮挡'], note: '第 2 页标题被遮挡', returnedAt: null,
    reworkTarget: 'BOTH', problemPages: [4, 2, 2, -1, 1.5], copyFields: ['TITLE', 'BODY'],
    problemAssetIds: [999], reviewerUsername: 'SECRET-REVIEWER',
  } }, 'REVIEWER');
  assert.ok(item);
  assert.deepEqual(item.previousReturn, {
    reasonLabels: ['文字遮挡'], note: '第 2 页标题被遮挡', returnedAt: null,
    reworkTarget: 'BOTH', problemPages: [2, 4], copyFields: ['TITLE', 'BODY'],
  });
  assert.equal(JSON.stringify(item).includes('999'), false);
  assert.equal(JSON.stringify(item).includes('SECRET-REVIEWER'), false);
  assert.equal(normalizeImageQaItem({ ...base, sampleKind: 'RANDOM', previousReturn: { note: '旧原因' } }, 'REVIEWER').previousReturn, undefined);
});
