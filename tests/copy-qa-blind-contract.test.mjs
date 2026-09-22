import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canReleaseCopyQaFreezeRest,
  canStartCopyQaBatchReturn,
  copyRevisionView,
  normalizeCopyQaItem,
  normalizeCopyQaList,
  normalizeCopyQaStatistics,
} from '../app/copy-qa/types.ts';

function collectKeysAndScalarValues(value, keys = [], values = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeysAndScalarValues(item, keys, values);
    return { keys, values };
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      keys.push(key);
      collectKeysAndScalarValues(item, keys, values);
    }
    return { keys, values };
  }
  if (value !== undefined && value !== null) values.push(String(value));
  return { keys, values };
}

function serverRow(patch = {}) {
  return {
    id: '71717171-7171-4717-8717-717171717171',
    freezePublicId: '81818181-8181-4818-8818-818181818181',
    anonymousCode: 'QA-000071',
    blindReview: true,
    status: 'PENDING',
    query: '如何整理小户型玄关',
    approvedRevision: {
      content: {
        copy: { title: '最终人工修改稿', body: '最终正文', tags: ['收纳'] },
        imagePlan: [{
          kind: 'hero',
          headline: '玄关收纳先分区',
          subtitle: '进门顺手归位',
          bullets: ['鞋包分区', '钥匙定点'],
          prompt: '明亮的小户型玄关，展示清晰的收纳分区。',
        }],
      },
      contentSha256: 'a'.repeat(64),
      revisionToken: 'a'.repeat(64),
    },
    productionBatch: { anonymousCode: 'PB-7XQK' },
    capabilities: { canPass: true, canReturnSingle: true, canReturnBatch: false },
    createdAt: '2026-09-09T08:00:00.000Z',
    ...patch,
  };
}

test('blind QA normalization is an allowlist even when the server accidentally attaches identity history', () => {
  const item = normalizeCopyQaItem(serverRow({
    taskId: 991,
    queryPackageName: 'SECRET-ROOT-PACKAGE',
    queryPackage: { id: 12, name: 'SECRET-PACKAGE' },
    productionBatch: { anonymousCode: 'PB-7XQK', queryPackageName: 'SECRET-BATCH-PACKAGE' },
    source: {
      taskId: 991,
      creatorUsername: 'SECRET-CREATOR',
      assignee: { username: 'SECRET-ASSIGNEE', avatarUrl: 'SECRET-AVATAR' },
      finalApprover: { username: 'SECRET-APPROVER' },
      assessments: [{ score: 2, reviewerUsername: 'SECRET-REVIEWER', reasonCodes: ['SECRET-REASON'] }],
    },
    auditHistory: [{ actorUsername: 'SECRET-AUDITOR' }],
    samplingPolicy: { rateBps: 5000, rateSource: 'ACCOUNT_OVERRIDE', globalPolicyVersion: 4, accountPolicyVersion: 8 },
  }));

  assert.ok(item);
  assert.equal(item.blindReview, true);
  assert.equal(item.id, '71717171-7171-4717-8717-717171717171');
  assert.equal(item.approvedRevision.revisionToken, 'a'.repeat(64),
    'the immutable final approved revision remains reviewable through an opaque token');
  assert.equal(item.approvedRevision.content.copy.title, '最终人工修改稿');
  assert.deepEqual(copyRevisionView(item.approvedRevision.content).imagePlan, [{
    kind: 'hero',
    headline: '玄关收纳先分区',
    subtitle: '进门顺手归位',
    bullets: ['鞋包分区', '钥匙定点'],
    prompt: '明亮的小户型玄关，展示清晰的收纳分区。',
  }]);

  const { keys, values } = collectKeysAndScalarValues(item);
  const normalizedKeys = keys.map((key) => key.toLocaleLowerCase('en-US'));
  for (const forbidden of [
    'taskid', 'querypackage', 'querypackagename', 'source', 'creatorusername', 'assignee', 'avatarurl',
    'finalapprover', 'assessments', 'score', 'reviewerusername', 'reasoncodes', 'audithistory',
    'revision', 'samplingpolicy', 'ratebps', 'ratesource', 'accountpolicyversion',
  ]) {
    assert.equal(normalizedKeys.includes(forbidden), false, forbidden);
  }
  for (const secret of [
    '991', 'SECRET-PACKAGE', 'SECRET-ROOT-PACKAGE', 'SECRET-BATCH-PACKAGE', 'SECRET-CREATOR', 'SECRET-ASSIGNEE', 'SECRET-AVATAR',
    'SECRET-APPROVER', 'SECRET-REVIEWER', 'SECRET-REASON', 'SECRET-AUDITOR',
  ]) {
    assert.equal(values.includes(secret), false, secret);
  }
  assert.deepEqual(values.filter((value) => /^\d+$/u.test(value)), [],
    'blind DTO contains no numeric task, batch or revision identifiers');
});

test('copy QA revision view reads image-copy planning from current and reviewed revision shapes', () => {
  const current = copyRevisionView(serverRow().approvedRevision.content);
  assert.equal(current.title, '最终人工修改稿');
  assert.equal(current.imagePlan[0].headline, '玄关收纳先分区');

  const legacy = copyRevisionView({
    reviewed: {
      copy: { title: '返工最终稿', body: '返工正文', tags: ['玄关'] },
      imagePlan: [{ kind: 'steps', headline: '三步归位', subtitle: '', bullets: ['清空', '分区', '归位'], prompt: '三步流程图。' }],
    },
  });
  assert.equal(legacy.title, '返工最终稿');
  assert.deepEqual(legacy.imagePlan[0], {
    kind: 'steps', headline: '三步归位', subtitle: '', bullets: ['清空', '分区', '归位'], prompt: '三步流程图。',
  });
});

test('blind list normalization cannot be changed into a non-blind row by nested source fields', () => {
  const [item] = normalizeCopyQaList({ items: [serverRow({
    source: { taskId: 991, finalApprover: 'SECRET-APPROVER' },
  })] });
  assert.deepEqual(Object.keys(item).toSorted(), [
    'anonymousCode', 'approvedRevision', 'blindReview', 'capabilities', 'createdAt',
    'freezePublicId', 'id', 'productionBatch', 'query', 'sampleKind', 'status',
  ]);
  assert.equal(Object.hasOwn(item, 'source'), false);
});

test('mandatory rechecks and batch-affected history retain the backend enum meaning', () => {
  const item = normalizeCopyQaItem(serverRow({
    sampleKind: 'MANDATORY_RECHECK',
    status: 'BATCH_AFFECTED',
  }));
  assert.ok(item);
  assert.equal(item.sampleKind, 'MANDATORY_RECHECK');
  assert.equal(item.status, 'BATCH_AFFECTED');
});

test('administrator normalization preserves direct-pass audit origin and superseded history', () => {
  const item = normalizeCopyQaItem(serverRow({
    blindReview: false,
    status: 'SUPERSEDED',
    reviewMethod: 'ADMIN_DIRECT',
    taskId: 991,
    approvedRevision: { ...serverRow().approvedRevision, id: 902 },
    productionBatch: { anonymousCode: 'PB-7XQK', id: 27, queryPackageName: '九月选题' },
    source: { finalApproverAccountId: 64 },
  }));

  assert.ok(item && !item.blindReview);
  assert.equal(item.status, 'SUPERSEDED');
  assert.equal(item.reviewMethod, 'ADMIN_DIRECT');
});

test('unknown QA state and omitted capabilities fail closed', () => {
  assert.equal(normalizeCopyQaItem(serverRow({ status: 'FUTURE_SERVER_STATE' })), null);

  const item = normalizeCopyQaItem(serverRow({ capabilities: undefined }));
  assert.ok(item);
  assert.deepEqual(item.capabilities, {
    canPass: false,
    canReturnSingle: false,
    canReturnBatch: false,
  });
});

test('only random first-review items may release or start a batch return', () => {
  const randomPending = normalizeCopyQaItem(serverRow({
    sampleKind: 'RANDOM',
    capabilities: { canPass: true, canReturnSingle: true, canReturnBatch: true },
  }));
  const randomReturned = normalizeCopyQaItem(serverRow({
    sampleKind: 'RANDOM',
    status: 'RETURNED',
    capabilities: { canPass: false, canReturnSingle: false, canReturnBatch: true },
  }));
  const mandatoryReturned = normalizeCopyQaItem(serverRow({
    sampleKind: 'MANDATORY_RECHECK',
    status: 'RETURNED',
    capabilities: { canPass: false, canReturnSingle: false, canReturnBatch: true },
  }));
  assert.ok(randomPending && randomReturned && mandatoryReturned);
  assert.equal(canStartCopyQaBatchReturn(randomPending), true);
  assert.equal(canStartCopyQaBatchReturn(randomReturned), true);
  assert.equal(canReleaseCopyQaFreezeRest(randomReturned), true);
  assert.equal(canStartCopyQaBatchReturn(mandatoryReturned), false);
  assert.equal(canReleaseCopyQaFreezeRest(mandatoryReturned), false);
});

test('non-blind normalization accepts current nested provenance and legacy root identifiers', () => {
  const current = normalizeCopyQaItem(serverRow({
    blindReview: false,
    taskId: 991,
    approvedRevision: {
      content: { copy: { title: '管理员可见稿', body: '正文', tags: [] } },
      contentSha256: 'c'.repeat(64),
      revisionToken: 'c'.repeat(64),
      id: 902,
    },
    productionBatch: { anonymousCode: 'PB-7XQK', id: 27, publicId: '91919191-9191-4919-8919-919191919191', queryPackageName: '  九月   选题  ' },
    source: { finalApproverAccountId: 64, finalApproverUsername: 'worker' },
  }));
  assert.ok(current && !current.blindReview);
  assert.equal(current.productionBatchId, 27);
  assert.equal(current.productionBatch.queryPackageName, '九月 选题');
  assert.equal(current.finalApproverAccountId, 64);
  assert.equal(current.approvedRevision.id, 902);

  const legacy = normalizeCopyQaItem(serverRow({
    blindReview: false,
    taskId: 992,
    productionBatchId: 28,
    freezeId: 18,
    finalApproverAccountId: 65,
    approvedRevision: { ...serverRow().approvedRevision, id: 903 },
  }));
  assert.ok(legacy && !legacy.blindReview);
  assert.equal(legacy.productionBatchId, 28);
  assert.equal(legacy.freezeId, 18);
  assert.equal(legacy.finalApproverAccountId, 65);
});

test('only administrators retain the frozen policy, without coercing missing rates to zero', () => {
  const policy = { rateBps: 0, rateSource: 'ACCOUNT_OVERRIDE', globalPolicyVersion: 4, accountPolicyVersion: 8, frozenAt: '2026-09-22T00:00:00.000Z' };
  assert.deepEqual(normalizeCopyQaItem(serverRow({ samplingPolicy: policy }), { role: 'ADMIN' }).samplingPolicy, policy);
  assert.equal(normalizeCopyQaItem(serverRow({ blindReview: false, samplingPolicy: policy }), { role: 'REVIEWER' }).samplingPolicy, undefined);
  assert.equal(normalizeCopyQaItem(serverRow({ samplingPolicy: { ...policy, rateBps: null } }), { role: 'ADMIN' }).samplingPolicy, undefined);
});

test('administrator normalization keeps full provenance even when a mixed-version response carries the blind flag', () => {
  const item = normalizeCopyQaItem(serverRow({
    taskId: 991,
    approvedRevision: { ...serverRow().approvedRevision, id: 902 },
    productionBatch: { anonymousCode: 'PB-7XQK', id: 27, queryPackageName: '九月选题' },
    source: {
      finalApproverAccountId: 64,
      finalApproverUsername: 'approver',
      assignedToUserId: 'worker',
      createdByUserId: 'creator',
    },
  }), { role: 'ADMIN' });

  assert.ok(item && !item.blindReview);
  assert.equal(item.query, '如何整理小户型玄关');
  assert.equal(item.taskId, 991);
  assert.equal(item.productionBatch.queryPackageName, '九月选题');
  assert.equal(item.finalApproverUsername, 'approver');
  assert.equal(item.assignedToUserId, 'worker');
  assert.equal(item.createdByUserId, 'creator');
});

test('administrator statistics preserve the final approver username for display', () => {
  const statistics = normalizeCopyQaStatistics({
    random: [{
      finalApproverAccountId: 64,
      finalApproverUsername: '  worker  ',
      finalApproverDisplayName: '  张三   质检员  ',
      passed: 3,
      returned: 1,
      decided: 4,
      accuracyRate: 0.75,
      overallPassed: 4,
      overallPassRate: 1,
    }],
    mandatory: { passed: 0, returned: 0, pending: 0 },
    batchAffectedCount: 0,
  });

  assert.ok(statistics);
  assert.equal(statistics.random[0].finalApproverUsername, 'worker');
  assert.equal(statistics.random[0].finalApproverDisplayName, '张三 质检员');
  assert.equal(statistics.random[0].overallPassed, 4);
  assert.equal(statistics.random[0].overallPassRate, 1);
});
