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

function freezeFixture() {
  const state = {
    batch: {
      id: 55,
      public_id: '55555555-5555-4555-8555-555555555555',
      status: 'OPEN',
      sampling_status: 'OPEN',
      version: 3,
      sampling_seed: 'copy-sampling-v1',
    },
    freezeInserts: 0,
    strata: [],
    members: [],
    calls: [],
  };
  const query = async (sql, values = []) => {
    const source = String(sql).replace(/\s+/gu, ' ').trim();
    state.calls.push({ sql: source, values });
    if (source.startsWith('SELECT task.id, approval.approved_by_account_id')) return { rows: state.freezeInserts ? [] : [{ id: 101, account_id: 41, approved_at: new Date() }] };
    if (source.startsWith('INSERT INTO copy_sampling_remainders') || source.startsWith('UPDATE copy_sampling_remainders')) return { rows: [] };
    if (source.startsWith('SELECT remainder_bps')) return { rows: [{ remainder_bps: 0 }] };
    if (source === 'SELECT * FROM production_batches WHERE id = $1 FOR UPDATE') {
      return { rows: [{ ...state.batch }] };
    }
    if (source.startsWith('SELECT COUNT(*) AS total_count') && source.includes('production_batch_items')) {
      return { rows: [{ total_count: '2', approved_count: '1', cancelled_count: '1', blocker_task_ids: [] }] };
    }
    if (source === 'SELECT * FROM workflow_quality_settings WHERE singleton = 1') {
      return { rows: [{
        singleton: 1,
        query_package_worker_import_enabled: false,
        copy_sampling_enabled: true,
        copy_sampling_rate_bps: 10_000,
        blind_review_enabled: true,
        reviewer_batch_return_enabled: false,
        version: 7,
      }] };
    }
    if (source.startsWith('SELECT task.id AS task_id')) {
      return { rows: [{
        task_id: 101,
        copy_revision_id: 901,
        approval_event_id: 801,
        final_approver_account_id: 41,
        final_approver_username: 'approver-41',
        content_sha256: 'a'.repeat(64),
      }] };
    }
    if (source.startsWith('INSERT INTO copy_sampling_freezes')) {
      state.freezeInserts += 1;
      return { rows: [{ id: 71, public_id: FREEZE_ID, production_batch_id: 55, status: 'INSPECTING' }] };
    }
    if (source.startsWith('INSERT INTO copy_sampling_strata')) {
      state.strata.push({ accountId: values[1], populationCount: values[2], quota: values[3] });
      return { rows: [] };
    }
    if (source.startsWith('INSERT INTO copy_sampling_items')) {
      state.members.push({
        taskId: Number(values[2]), approvalEventId: Number(values[3]), revisionId: Number(values[4]),
        contentSha256: values[5], selected: values[9], status: values[10],
      });
      return { rows: [] };
    }
    if (source.startsWith('UPDATE tasks SET current_stage = $2')) return { rows: [] };
    if (source.startsWith("UPDATE production_batches SET status = 'FROZEN'")) {
      state.batch.status = 'FROZEN';
      state.batch.sampling_status = 'FROZEN';
      state.batch.version += 1;
      return { rows: [] };
    }
    if (source.startsWith("UPDATE production_batches SET status = 'RELEASED'")) return { rows: [] };
    if (source.startsWith('INSERT INTO copy_sampling_events')) return { rows: [] };
    throw new Error(`unexpected SQL: ${source}`);
  };
  return { state, client: { query } };
}

test('the last initial DISCARD closes the batch and freezes only final approved revisions once', async () => {
  const fixture = freezeFixture();
  const frozen = await attemptAutomaticCopySamplingFreeze(fixture.client, 55, admin);

  assert.equal(frozen.frozen, true);
  assert.equal(frozen.freezes[0].freezeId, FREEZE_ID);
  assert.equal(frozen.freezes[0].populationCount, 1);
  assert.equal(frozen.freezes[0].sampleCount, 1);
  assert.deepEqual(fixture.state.members, [{
    taskId: 101,
    approvalEventId: 801,
    revisionId: 901,
    contentSha256: 'a'.repeat(64),
    selected: true,
    status: 'PENDING',
  }]);

  const refreshed = await attemptAutomaticCopySamplingFreeze(fixture.client, 55, admin);
  assert.deepEqual(refreshed, { frozen: false, freezes: [] });
  assert.equal(fixture.state.freezeInserts, 1, 'refresh/retry cannot redraw a frozen batch');
});

test('manual closure is idempotent even when the batch has no approved tail', async () => {
  const fixture = freezeFixture();
  fixture.state.freezeInserts = 1;
  assert.deepEqual(await attemptAutomaticCopySamplingFreeze(fixture.client, 55, admin, { close: true }), { frozen: false, freezes: [] });
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

test('both APPROVE and the final DISCARD attempt automatic batch closure', async () => {
  const source = await readFile(new URL('../src/postgres-repository.mjs', import.meta.url), 'utf8');
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
