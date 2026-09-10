import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  attemptAutomaticCopySamplingFreeze,
  freezeCopySamplingBatch,
  insertCopyApprovalEvent,
} from '../src/copy-quality-control.mjs';

const FREEZE_ID = '81818181-8181-4818-8818-818181818181';
const admin = Object.freeze({ userId: 1, username: 'admin', role: 'ADMIN' });

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
    if (source.startsWith('INSERT INTO copy_sampling_events')) return { rows: [] };
    throw new Error(`unexpected SQL: ${source}`);
  };
  return { state, client: { query } };
}

test('the last initial DISCARD closes the batch and freezes only final approved revisions once', async () => {
  const fixture = freezeFixture();
  const frozen = await attemptAutomaticCopySamplingFreeze(fixture.client, 55, admin);

  assert.equal(frozen.ready, true);
  assert.equal(frozen.approvedCount, 1);
  assert.equal(frozen.cancelledCount, 1);
  assert.equal(frozen.freezeId, FREEZE_ID);
  assert.equal(frozen.populationCount, 1);
  assert.equal(frozen.sampleCount, 1);
  assert.deepEqual(fixture.state.members, [{
    taskId: 101,
    approvalEventId: 801,
    revisionId: 901,
    contentSha256: 'a'.repeat(64),
    selected: true,
    status: 'PENDING',
  }]);

  const refreshed = await attemptAutomaticCopySamplingFreeze(fixture.client, 55, admin);
  assert.deepEqual(refreshed, { ready: false, reason: 'ALREADY_FROZEN' });
  assert.equal(fixture.state.freezeInserts, 1, 'refresh/retry cannot redraw a frozen batch');
});

test('explicit freeze refuses an incomplete batch before reading policy or drawing members', async () => {
  let readPolicy = false;
  let drewPopulation = false;
  const query = async (sql) => {
    const source = String(sql).replace(/\s+/gu, ' ').trim();
    if (['BEGIN', 'ROLLBACK', 'COMMIT'].includes(source)) return { rows: [] };
    if (source.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [{}] };
    if (source.startsWith('SELECT id FROM app_users')) return { rows: [{ id: admin.userId }] };
    if (source.startsWith('SELECT * FROM copy_sampling_mutation_requests')) return { rows: [] };
    if (source === 'SELECT * FROM production_batches WHERE id = $1 FOR UPDATE') {
      return { rows: [{ id: 55, version: 3, sampling_status: 'OPEN' }] };
    }
    if (source.startsWith('SELECT COUNT(*) AS total_count')) {
      return { rows: [{ total_count: '3', approved_count: '1', cancelled_count: '1', blocker_task_ids: [103] }] };
    }
    if (source.includes('workflow_quality_settings')) readPolicy = true;
    if (source.startsWith('SELECT task.id AS task_id')) drewPopulation = true;
    throw new Error(`unexpected SQL: ${source}`);
  };
  const client = { query, release() {} };
  await assert.rejects(freezeCopySamplingBatch({ connect: async () => client }, 55, {
    expectedVersion: 3,
    requestId: '11111111-1111-4111-8111-111111111111',
  }, admin), (error) => {
    assert.equal(error.code, 'INITIAL_REVIEW_INCOMPLETE');
    assert.deepEqual(error.details, {
      totalCount: 3,
      approvedCount: 1,
      cancelledCount: 1,
      blockerCount: 1,
      blockerTaskIds: [103],
      ready: false,
    });
    return true;
  });
  assert.equal(readPolicy, false);
  assert.equal(drewPopulation, false);
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
