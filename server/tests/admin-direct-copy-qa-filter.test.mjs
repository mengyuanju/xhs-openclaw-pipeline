import assert from 'node:assert/strict';
import test from 'node:test';

import {
  adminDirectApproveCopyQa,
  listCopyQaItems,
} from '../src/copy-quality-control.mjs';

const ITEM_ID = '71717171-7171-4717-8717-717171717171';
const FREEZE_ID = '81818181-8181-4818-8818-818181818181';
const REQUEST_ID = '91919191-9191-4919-8919-919191919191';
const admin = Object.freeze({ userId: 1, username: 'admin', role: 'ADMIN' });
const reviewer = Object.freeze({ userId: 91, username: 'reviewer', role: 'REVIEWER' });

function qaRow(patch = {}) {
  return {
    id: 71,
    public_id: ITEM_ID,
    freeze_id: 18,
    freeze_public_id: FREEZE_ID,
    production_batch_id: 27,
    production_batch_public_id: '27272727-2727-4727-8727-272727272727',
    query_package_name: '九月选题',
    blind_review_enabled: true,
    reviewer_batch_return_enabled: false,
    task_id: 991,
    selected: true,
    status: 'PENDING',
    sample_kind: 'RANDOM',
    query: '如何整理小户型玄关',
    copy_revision_id: 902,
    copy_revision_number: 4,
    copy_content: { copy: { title: '最终人工修改稿', body: '正文', tags: [] } },
    content_sha256: 'a'.repeat(64),
    approval_event_id: 501,
    final_approver_account_id: 64,
    final_approver_username: 'approver',
    assigned_to_user_id: 'worker',
    created_by_user_id: 'worker',
    priority_paused: false,
    created_at: new Date('2026-09-09T08:00:00.000Z'),
    updated_at: new Date('2026-09-09T08:01:00.000Z'),
    ...patch,
  };
}

test('administrator direct-pass filter includes historical superseded items and keeps the origin visible', async () => {
  const calls = [];
  const pool = { async query(sql, values = []) {
    const source = String(sql).replace(/\s+/gu, ' ').trim();
    if (source.startsWith('SELECT id FROM app_users')) return { rows: [{ id: admin.userId }] };
    if (source.includes('SELECT DISTINCT task.production_batch_id')) return { rows: [] };
    calls.push({ sql: source, values });
    return { rows: [qaRow({ selected: false, status: 'SUPERSEDED', admin_direct_approval_id: 88 })] };
  } };

  const [item] = await listCopyQaItems(pool, { status: 'ADMIN_DIRECT_PASSED' }, admin);

  assert.equal(item.status, 'SUPERSEDED');
  assert.equal(item.reviewMethod, 'ADMIN_DIRECT');
  assert.deepEqual(calls[0].values, [null, null, 50, 0]);
  assert.match(calls[0].sql, /LEFT JOIN copy_qa_admin_direct_approvals AS direct_approval/u);
  assert.match(calls[0].sql, /item\.selected = true OR \(direct_approval\.id IS NOT NULL/u);
  assert.match(calls[0].sql, /item\.note IS NOT NULL AND reviewed_actor\.role = 'ADMIN'/u);
});

test('direct-pass filter recognizes administrator-noted rows created before origin persistence was fixed', async () => {
  const pool = { async query(sql) {
    const source = String(sql).replace(/\s+/gu, ' ').trim();
    if (source.startsWith('SELECT id FROM app_users')) return { rows: [{ id: admin.userId }] };
    if (source.includes('SELECT DISTINCT task.production_batch_id')) return { rows: [] };
    return { rows: [qaRow({
      status: 'PASSED',
      admin_direct_approval_id: null,
      reviewed_by_role: 'ADMIN',
      note: '管理员从所有作业单独通过',
    })] };
  } };

  const [item] = await listCopyQaItems(pool, { status: 'ADMIN_DIRECT_PASSED' }, admin);
  assert.equal(item.reviewMethod, 'ADMIN_DIRECT');
});

test('non-administrators cannot use the direct-pass audit filter', async () => {
  await assert.rejects(
    listCopyQaItems({ query: async () => assert.fail('authorization must happen before SQL') }, {
      status: 'ADMIN_DIRECT_PASSED',
    }, reviewer),
    (error) => error?.code === 'FORBIDDEN',
  );
});

test('all-jobs direct pass records its audit origin atomically and returns the refreshed task', async () => {
  const item = qaRow({
    production_batch_id: 27,
    task_state: 'COPY_QC_PENDING',
    current_copy_revision_id: 902,
  });
  const task = { id: 991, state: 'COPY_QC_PENDING', current_copy_revision_id: 902 };
  const queries = [];
  const client = { async query(sql, values = []) {
    const source = String(sql).replace(/\s+/gu, ' ').trim();
    queries.push({ sql: source, values });
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(source)) return { rows: [] };
    if (source.startsWith('SELECT id FROM app_users')) return { rows: [{ id: admin.userId }] };
    if (source.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [{}] };
    if (source.startsWith('SELECT id, task_id, freeze_id FROM copy_sampling_items')) {
      return { rows: [{ id: item.id, task_id: item.task_id, freeze_id: item.freeze_id }] };
    }
    if (source === 'SELECT * FROM tasks WHERE id = $1 FOR UPDATE') return { rows: [task] };
    if (source === 'SELECT * FROM tasks WHERE id = $1') return { rows: [task] };
    if (source === 'SELECT * FROM copy_sampling_freezes WHERE id = $1 FOR UPDATE') {
      return { rows: [{ id: item.freeze_id }] };
    }
    if (source.startsWith('SELECT item.*, sampling_freeze.status AS freeze_status')) {
      return { rows: [item] };
    }
    if (source.startsWith('SELECT * FROM copy_sampling_mutation_requests')) return { rows: [] };
    if (source.startsWith('SELECT COUNT(*) AS count FROM copy_sampling_items')) {
      return { rows: [{ count: '1' }] };
    }
    if (source.startsWith('UPDATE copy_sampling_items SET status = \'PASSED\'')) return { rows: [] };
    if (source.startsWith('INSERT INTO copy_qa_admin_direct_approvals')) return { rows: [] };
    if (source.startsWith('INSERT INTO copy_sampling_events')) return { rows: [] };
    if (source.startsWith('INSERT INTO copy_sampling_mutation_requests')) return { rows: [] };
    throw new Error(`unexpected SQL: ${source}`);
  }, release() {} };
  const pool = {
    connect: async () => client,
    query: async (sql, values = []) => {
      const source = String(sql).replace(/\s+/gu, ' ').trim();
      queries.push({ sql: source, values });
      if (source.startsWith('SELECT public_id FROM copy_sampling_items')) return { rows: [{ public_id: ITEM_ID }] };
      throw new Error(`unexpected pool SQL: ${source}`);
    },
  };

  const result = await adminDirectApproveCopyQa(pool, item.task_id, {
    expectedCopyRevisionId: item.copy_revision_id,
    requestId: REQUEST_ID,
    note: '管理员复核确认内容合格',
  }, admin);

  assert.equal(result.status, 'PASSED');
  assert.deepEqual(result.task, task);
  const directAudit = queries.find(({ sql }) => sql.startsWith('INSERT INTO copy_qa_admin_direct_approvals'));
  assert.deepEqual(directAudit.values, [item.task_id, item.copy_revision_id, item.approval_event_id,
    admin.userId, admin.username, REQUEST_ID]);
  const event = queries.find(({ sql }) => sql.startsWith('INSERT INTO copy_sampling_events'));
  assert.deepEqual(event.values.at(-1), { directAdminApproval: true });
  const receipt = queries.find(({ sql }) => sql.startsWith('INSERT INTO copy_sampling_mutation_requests'));
  assert.equal(receipt.values[3], 'ADMIN_DIRECT_PASS');
});
