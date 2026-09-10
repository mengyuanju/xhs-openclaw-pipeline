import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { getCopyQaItem, listCopyQaItems } from '../src/copy-quality-control.mjs';

const ITEM_PUBLIC_ID = '71717171-7171-4717-8717-717171717171';
const FREEZE_PUBLIC_ID = '81818181-8181-4818-8818-818181818181';
const HASH = 'a'.repeat(64);
const reviewer = Object.freeze({ userId: 91, username: 'qa-reviewer', role: 'REVIEWER' });
const opaqueCode = (prefix, value) => `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 12).toUpperCase()}`;

function databaseRow(patch = {}) {
  return {
    id: 71,
    public_id: ITEM_PUBLIC_ID,
    freeze_id: 18,
    freeze_public_id: FREEZE_PUBLIC_ID,
    production_batch_id: 27,
    production_batch_public_id: '27272727-2727-4727-8727-272727272727',
    blind_review_enabled: true,
    reviewer_batch_return_enabled: false,
    task_id: 991,
    selected: true,
    status: 'PENDING',
    query: '如何整理小户型玄关',
    copy_revision_id: 902,
    copy_revision_number: 4,
    copy_content: { copy: { title: '最终人工修改稿', body: '最终正文', tags: ['收纳'] } },
    content_sha256: HASH,
    final_approver_account_id: 64,
    final_approver_username: 'SECRET-APPROVER',
    assigned_to_user_id: 'SECRET-ASSIGNEE',
    created_by_user_id: 'SECRET-CREATOR',
    created_at: new Date('2026-09-09T08:00:00.000Z'),
    updated_at: new Date('2026-09-09T08:01:00.000Z'),
    ...patch,
  };
}

function collect(value, path = '$', rows = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collect(item, `${path}[${index}]`, rows));
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      rows.push({ type: 'key', path, value: key });
      collect(item, `${path}.${key}`, rows);
    }
  } else {
    rows.push({ type: 'value', path, value });
  }
  return rows;
}

function assertBlindAllowlist(payload) {
  const rows = collect(payload);
  const keys = rows.filter((row) => row.type === 'key').map((row) => row.value.toLocaleLowerCase('en-US'));
  for (const forbidden of [
    'taskid', 'freezeid', 'productionbatchid', 'copyrevisionid', 'revision',
    'accountid', 'userid', 'username', 'avatar', 'creator', 'assignee', 'finalapprover',
    'assessment', 'score', 'reasoncodes', 'history', 'source', 'querypackage',
  ]) {
    assert.equal(keys.includes(forbidden), false, forbidden);
  }
  const serialized = JSON.stringify(payload);
  for (const secret of [
    '991', '902', 'SECRET-APPROVER', 'SECRET-ASSIGNEE', 'SECRET-CREATOR',
    '27272727-2727-4727-8727-272727272727',
  ]) assert.equal(serialized.includes(secret), false, secret);
  assert.equal(serialized.includes('QC-00000071'), false,
    'an anonymous label must not encode the internal numeric sampling-item id');
  assert.deepEqual(rows.filter((row) => row.type === 'value' && typeof row.value === 'number'), [],
    'blind payload must not expose numeric task, batch, revision, item or account identifiers');
}

test('reviewer blind list and detail are recursively server-side allowlisted', async () => {
  const queries = [];
  const pool = { async query(sql, values) {
    queries.push({ sql: String(sql), values });
    return { rows: [databaseRow()] };
  } };

  const list = await listCopyQaItems(pool, { status: 'PENDING' }, reviewer);
  const detail = await getCopyQaItem(pool, ITEM_PUBLIC_ID, reviewer);
  assert.equal(list.length, 1);
  assert.equal(detail.id, ITEM_PUBLIC_ID);
  assert.equal(detail.approvedRevision.content.copy.title, '最终人工修改稿');
  assert.equal(detail.approvedRevision.revisionToken, HASH);
  assert.deepEqual(detail.productionBatch, {
    anonymousCode: opaqueCode('QCB', FREEZE_PUBLIC_ID),
  });
  assertBlindAllowlist(list);
  assertBlindAllowlist(detail);

  const listQuery = queries[0];
  assert.equal(listQuery.values[1], reviewer.userId,
    'reviewers cannot receive samples whose final approver account is themselves');
});

test('admin non-blind inspection retains traceable frozen identifiers', async () => {
  const admin = { userId: 1, username: 'admin', role: 'ADMIN' };
  const pool = { query: async () => ({ rows: [databaseRow()] }) };
  const detail = await getCopyQaItem(pool, ITEM_PUBLIC_ID, admin);
  assert.equal(detail.blindReview, false,
    'blindReview describes the current redacted response; administrators receive a traceable view');
  assert.equal(detail.taskId, 991);
  assert.equal(detail.approvedRevision.id, 902);
  assert.equal(detail.productionBatch.id, 27);
  assert.equal(detail.source.finalApproverAccountId, 64);
});

test('reviewers cannot turn an unselected batch-scope identifier into copy detail', async () => {
  const held = databaseRow({ selected: false, status: 'NOT_SELECTED' });
  const pool = { query: async () => ({ rows: [held] }) };

  await assert.rejects(getCopyQaItem(pool, ITEM_PUBLIC_ID, reviewer), { code: 'NOT_FOUND' });
  const admin = { userId: 1, username: 'admin', role: 'ADMIN' };
  const diagnostic = await getCopyQaItem(pool, ITEM_PUBLIC_ID, admin);
  assert.equal(diagnostic.taskId, held.task_id);
  assert.equal(diagnostic.status, 'NOT_SELECTED');
});
