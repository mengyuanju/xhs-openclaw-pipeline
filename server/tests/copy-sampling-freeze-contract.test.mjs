import { readRepositorySource } from './helpers/repository-source.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  adminDirectApproveCopyQa,
  attemptAutomaticCopySamplingFreeze,
  freezeCopySamplingBatch,
  getProductionBatchSamplingReadiness,
  insertCopyApprovalEvent,
} from '../src/copy-quality-control.mjs';

const FREEZE_ID = '81818181-8181-4818-8818-818181818181';
const admin = Object.freeze({ userId: 1, username: 'admin', role: 'ADMIN' });

test('production-batch readiness rejects ordinary users before database access', async () => {
  let queryCount = 0;
  const pool = { query: async () => { queryCount += 1; return { rows: [] }; } };
  await assert.rejects(
    getProductionBatchSamplingReadiness(pool, 55, {
      userId: 41,
      username: 'worker-41',
      role: 'USER',
    }),
    { code: 'FORBIDDEN' },
  );
  assert.equal(queryCount, 0);
});

test('legacy automatic production-batch freezes are inert after V2 migration', async () => {
  let queryCount = 0;
  const client = { query: async () => { queryCount++; assert.fail('retired automatic freeze must be inert'); } };
  for (const batchId of [55, null]) {
    assert.equal(await attemptAutomaticCopySamplingFreeze(client, batchId, admin), null);
    assert.equal(await attemptAutomaticCopySamplingFreeze(client, batchId, admin), null);
  }
  assert.equal(queryCount, 0, 'discard and retry must not create a second legacy sampling scope');
});

test('manual closure cannot revive retired legacy sampling', async () => {
  const client = { query: async () => assert.fail('retired manual close must not query') };
  assert.equal(await attemptAutomaticCopySamplingFreeze(client, 55, admin, { close: true }), null);
});

test('approval-event idempotency uses the exact immutable revision uniqueness contract', async () => {
  const rows = [];
  const calls = [];
  const client = { async query(sql, values) {
    const source = String(sql).replace(/\s+/gu, ' ').trim();
    calls.push(source);
    if (source.startsWith('INSERT INTO copy_approval_events')) {
      if (rows.length) return { rows: [] };
      const row = { id: 1, task_id: values[0], copy_revision_id: values[1], content_sha256: values[7] };
      rows.push(row);
      return { rows: [row] };
    }
    if (source.startsWith('SELECT * FROM copy_approval_events')) return { rows: [...rows] };
    throw new Error(`unexpected SQL: ${source}`);
  } };
  const input = {
    taskId: 101,
    copyRevisionId: 901,
    assessmentId: 501,
    actor: { userId: 41, username: 'approver-41' },
    reviewSessionId: '22222222-2222-4222-8222-222222222222',
    content: { copy: { title: '最终版本', body: '正文', tags: [] } },
  };

  const first = await insertCopyApprovalEvent(client, input);
  const replay = await insertCopyApprovalEvent(client, input);
  assert.deepEqual(replay, first);
  assert.match(calls[0], /ON CONFLICT \(task_id, copy_revision_id\) DO NOTHING/u);

  await assert.rejects(insertCopyApprovalEvent(client, {
    ...input,
    content: { copy: { title: '同 revision 被篡改', body: '正文', tags: [] } },
  }), { code: 'COPY_APPROVAL_CONFLICT' });
});

test('APPROVE enters V2 approval routing and DISCARD retains the inert compatibility call', async () => {
  const source = await readRepositorySource();
  assert.match(source,
    /if \(decision === 'APPROVE'\) \{[\s\S]{0,1200}routeManualCopyApproval\(client/u);
  assert.match(source,
    /if \(decision === 'DISCARD'\) \{[\s\S]{0,1800}attemptAutomaticCopySamplingFreeze\(client[\s\S]{0,500}return taskFrom\(discarded\.rows\[0\]\)/u);
});

test('administrator direct approval requires an audit reason', async () => {
  await assert.rejects(adminDirectApproveCopyQa({}, 101, { expectedCopyRevisionId: 901, requestId: FREEZE_ID }, admin), /note is required/u);
});

test('administrator direct approval cannot queue an uninspected task', async () => {
  await assert.rejects(adminDirectApproveCopyQa({ query: async () => ({ rows: [] }) }, 101,
    { expectedCopyRevisionId: 901, requestId: FREEZE_ID, note: 'reviewed' }, admin), { code: 'QA_ITEM_REQUIRED' });
});
