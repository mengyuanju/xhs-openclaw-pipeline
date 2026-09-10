import assert from 'node:assert/strict';
import test from 'node:test';

import {
  batchReturnCopyQa,
  getCopyQaBatchReturnPreview,
  getCopyQaStatistics,
} from '../src/copy-quality-control.mjs';

const FREEZE_ID = '81818181-8181-4818-8818-818181818181';
const ITEM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ITEM_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ITEM_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SNAPSHOT_SHA256 = 'f'.repeat(64);
const reviewer = Object.freeze({ userId: 91, username: 'qa-reviewer', role: 'REVIEWER' });
const admin = Object.freeze({ userId: 1, username: 'admin', role: 'ADMIN' });

function settingsRow(enabled) {
  return {
    singleton: 1,
    query_package_worker_import_enabled: false,
    copy_sampling_enabled: true,
    copy_sampling_rate_bps: 2_000,
    blind_review_enabled: true,
    reviewer_batch_return_enabled: enabled,
    version: 2,
  };
}

function batchItems() {
  return [
    {
      id: 11, public_id: ITEM_A, freeze_id: 18, task_id: 101, copy_revision_id: 201,
      content_sha256: '1'.repeat(64), selected: true, sample_kind: 'RANDOM', status: 'PENDING',
      task_state: 'COPY_QC_PENDING', current_copy_revision_id: 201,
    },
    {
      id: 12, public_id: ITEM_B, freeze_id: 18, task_id: 102, copy_revision_id: 202,
      content_sha256: '2'.repeat(64), selected: false, sample_kind: 'RANDOM', status: 'NOT_SELECTED',
      task_state: 'COPY_QC_PENDING', current_copy_revision_id: 202,
    },
    {
      id: 13, public_id: ITEM_C, freeze_id: 18, task_id: 103, copy_revision_id: 203,
      content_sha256: '3'.repeat(64), selected: true, sample_kind: 'RANDOM', status: 'PASSED',
      task_state: 'COPY_QC_PENDING', current_copy_revision_id: 203,
    },
  ];
}

function previewPool({ reviewerBatchReturnEnabled = true } = {}) {
  const rows = batchItems();
  const queries = [];
  return {
    queries,
    async query(sql, values = []) {
      const source = String(sql).replace(/\s+/gu, ' ').trim();
      queries.push({ sql: source, values });
      if (source === 'SELECT * FROM workflow_quality_settings WHERE singleton = 1') {
        return { rows: [settingsRow(reviewerBatchReturnEnabled)] };
      }
      if (source.startsWith('SELECT sampling_freeze.*, batch.public_id AS batch_public_id')) {
        return { rows: [{
          id: 18, public_id: FREEZE_ID, status: 'INSPECTING', version: 4,
          blind_review_enabled: true, production_batch_id: 27,
          batch_public_id: '27272727-2727-4727-8727-272727272727',
        }] };
      }
      if (source.startsWith('SELECT item.*, task.state AS task_state')) return { rows: structuredClone(rows) };
      throw new Error(`unexpected SQL: ${source}`);
    },
  };
}

function assertBlindPreview(preview) {
  assert.equal(preview.freezePublicId, FREEZE_ID);
  assert.equal(preview.confirmedCount, 3);
  assert.deepEqual(preview.triggerCandidates, [ITEM_A]);
  assert.deepEqual(preview.items.map(({ id, status, selected, sampleKind }) => ({ id, status, selected, sampleKind })), [
    { id: ITEM_A, status: 'PENDING', selected: true, sampleKind: 'RANDOM' },
    { id: ITEM_B, status: 'NOT_SELECTED', selected: false, sampleKind: 'RANDOM' },
    { id: ITEM_C, status: 'PASSED', selected: true, sampleKind: 'RANDOM' },
  ]);
  const serialized = JSON.stringify(preview);
  for (const forbiddenKey of ['"taskId"', '"copyRevisionId"', '"productionBatchId"']) {
    assert.equal(serialized.includes(forbiddenKey), false, forbiddenKey);
  }
  for (const item of preview.items) {
    assert.match(item.memberHash, /^[a-f0-9]{64}$/u);
    assert.match(item.revisionToken, /^[a-f0-9]{64}$/u);
  }
}

test('batch preview creates a complete opaque atomic scope and exposes only random pending triggers', async () => {
  const pool = previewPool();
  assertBlindPreview(await getCopyQaBatchReturnPreview(pool, FREEZE_ID, reviewer));
});

test('reviewer batch preview follows only its switch while admin always retains batch scope', async () => {
  const reviewerPool = previewPool({ reviewerBatchReturnEnabled: false });
  await assert.rejects(getCopyQaBatchReturnPreview(reviewerPool, FREEZE_ID, reviewer), { code: 'FORBIDDEN' });
  assert.equal(reviewerPool.queries.length, 1, 'permission is checked before reading the batch');

  const adminPool = previewPool({ reviewerBatchReturnEnabled: false });
  const preview = await getCopyQaBatchReturnPreview(adminPool, FREEZE_ID, admin);
  assert.equal(preview.confirmedCount, 3);
});

function batchActionFixture({ reviewerBatchReturnEnabled = true, blind = true,
  actorActive = true, taskLockError = null } = {}) {
  const state = {
    items: batchItems(),
    queries: [],
    taskUpdates: [],
    itemUpdates: [],
    eventDetails: null,
    mutations: new Map(),
  };
  const query = async (sql, values = []) => {
    const source = String(sql).replace(/\s+/gu, ' ').trim();
    state.queries.push({ sql: source, values });
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(source)) return { rows: [] };
    if (source.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [{}] };
    if (source.startsWith('SELECT id FROM app_users')) {
      return { rows: actorActive ? [{ id: Number(values[0]) }] : [] };
    }
    if (source.startsWith('SELECT * FROM copy_sampling_mutation_requests')) {
      const row = state.mutations.get(`${values[0]}:${values[1]}`);
      return { rows: row ? [structuredClone(row)] : [] };
    }
    if (source.startsWith('INSERT INTO copy_sampling_mutation_requests')) {
      state.mutations.set(`${values[0]}:${values[2]}`, {
        actor_account_id: values[0], actor_username: values[1], request_id: values[2], operation: values[3],
        request_fingerprint: values[4], response: structuredClone(values[5]),
      });
      return { rows: [] };
    }
    if (source === 'SELECT * FROM workflow_quality_settings WHERE singleton = 1 FOR SHARE') {
      return { rows: [settingsRow(reviewerBatchReturnEnabled)] };
    }
    if (source.startsWith('SELECT id FROM copy_sampling_freezes')) return { rows: [{ id: 18 }] };
    if (source.startsWith('SELECT task.id FROM copy_sampling_items')) {
      if (taskLockError) throw Object.assign(new Error('row is busy'), { code: taskLockError });
      return { rows: [] };
    }
    if (source.startsWith('SELECT * FROM copy_sampling_freezes') && source.includes('WHERE id = $1')) {
      return { rows: [{
        id: 18, public_id: FREEZE_ID, production_batch_id: 27,
        status: 'INSPECTING', blind_review_enabled: blind, snapshot_sha256: SNAPSHOT_SHA256,
      }] };
    }
    if (source.startsWith('SELECT item.*, task.state AS task_state')) return { rows: structuredClone(state.items) };
    if (source.startsWith('SELECT * FROM copy_revisions WHERE id = $1')) {
      const item = state.items.find((candidate) => candidate.copy_revision_id === Number(values[0]));
      return { rows: item ? [{
        id: item.copy_revision_id,
        task_id: item.task_id,
        revision: 1,
        content: { copy: { title: `任务 ${item.task_id}`, body: '正文', tags: [] } },
        copy_content_changed_from_machine: true,
      }] : [] };
    }
    if (source.startsWith('SELECT COALESCE(MAX(revision), 0) + 1 AS revision')) return { rows: [{ revision: '2' }] };
    if (source.startsWith('INSERT INTO copy_revisions')) {
      return { rows: [{ id: Number(values[0]) + 1_000, task_id: Number(values[0]), revision: Number(values[1]), content: values[2] }] };
    }
    if (source.startsWith("UPDATE tasks SET state = 'COPY_REVIEW_PENDING'")) {
      state.taskUpdates.push(Number(values[0]));
      return { rows: [] };
    }
    if (source.startsWith('UPDATE copy_sampling_items SET status = $2')) {
      state.itemUpdates.push({
        id: Number(values[0]), status: values[1], reasonCodes: values[4], note: values[5], reviewedNow: values[6],
      });
      return { rows: [] };
    }
    if (source.startsWith("UPDATE copy_sampling_freezes SET status = 'BATCH_RETURNED'")) return { rows: [] };
    if (source.startsWith("UPDATE production_batches SET status = 'BATCH_RETURNED'")) return { rows: [] };
    if (source.startsWith('INSERT INTO copy_sampling_events')) {
      state.eventDetails = structuredClone(values[7]);
      return { rows: [] };
    }
    throw new Error(`unexpected SQL: ${source}`);
  };
  const client = { query, release() {} };
  return { state, pool: { connect: async () => client } };
}

function batchRequest(patch = {}) {
  return {
    freezePublicId: FREEZE_ID,
    triggerSamplingItemId: ITEM_A,
    itemIds: [ITEM_A, ITEM_B, ITEM_C],
    reasonCodes: ['SYSTEMATIC_FACT_ERROR'],
    note: '抽中的错误说明同批次需要全部返修',
    confirmedCount: 3,
    requestId: '11111111-1111-4111-8111-111111111111',
    ...patch,
  };
}

test('batch return marks only the trigger as an error and all other members as affected', async () => {
  const fixture = batchActionFixture();
  const result = await batchReturnCopyQa(fixture.pool, batchRequest(), reviewer);

  assert.deepEqual(result, {
    freezePublicId: FREEZE_ID,
    status: 'BATCH_RETURNED',
    triggerSamplingItemId: ITEM_A,
    affectedCount: 2,
  });
  assert.deepEqual(fixture.state.taskUpdates.toSorted((a, b) => a - b), [101, 102, 103]);
  assert.deepEqual(fixture.state.itemUpdates, [
    { id: 11, status: 'RETURNED', reasonCodes: ['SYSTEMATIC_FACT_ERROR'], note: '抽中的错误说明同批次需要全部返修', reviewedNow: true },
    { id: 12, status: 'BATCH_AFFECTED', reasonCodes: [], note: null, reviewedNow: false },
    { id: 13, status: 'BATCH_AFFECTED', reasonCodes: [], note: null, reviewedNow: false },
  ]);
  assert.equal(fixture.state.eventDetails.triggerSamplingItemId, ITEM_A);
  assert.deepEqual(fixture.state.eventDetails.affectedItemIds, [ITEM_B, ITEM_C]);
  assert.equal(fixture.state.eventDetails.affectedCount, 2);
  assert.equal(fixture.state.eventDetails.snapshotSha256, SNAPSHOT_SHA256);
  assert.deepEqual(fixture.state.eventDetails.memberHashes.map(({ id }) => id), [ITEM_A, ITEM_B, ITEM_C]);
  for (const member of fixture.state.eventDetails.memberHashes) {
    assert.match(member.memberHash, /^[a-f0-9]{64}$/u);
  }
  const actorLock = fixture.state.queries.findIndex(({ sql }) => sql.startsWith('SELECT id FROM app_users'));
  const settingsLock = fixture.state.queries.findIndex(({ sql }) => sql.endsWith('FOR SHARE')
    && sql.includes('workflow_quality_settings'));
  const freezeLookup = fixture.state.queries.findIndex(({ sql }) => sql.startsWith('SELECT id FROM copy_sampling_freezes'));
  const taskLock = fixture.state.queries.findIndex(({ sql }) => sql.startsWith('SELECT task.id FROM copy_sampling_items'));
  const freezeLock = fixture.state.queries.findIndex(({ sql }) => sql.startsWith('SELECT * FROM copy_sampling_freezes')
    && sql.includes('WHERE id = $1'));
  const itemLock = fixture.state.queries.findIndex(({ sql }) => sql.startsWith('SELECT item.*, task.state AS task_state'));
  assert.ok(actorLock < settingsLock && settingsLock < freezeLookup && freezeLookup < taskLock
    && taskLock < freezeLock && freezeLock < itemLock,
  'the write locks actor/settings first, then tasks, freeze and items in a stable order');
  assert.match(fixture.state.queries[taskLock].sql, /ORDER BY task\.id FOR UPDATE OF task NOWAIT/u);
  assert.match(fixture.state.queries[itemLock].sql, /FOR UPDATE OF item$/u);

  const replay = await batchReturnCopyQa(fixture.pool, batchRequest(), reviewer);
  assert.deepEqual(replay, result);
  assert.equal(fixture.state.taskUpdates.length, 3, 'idempotent replay cannot append another set of revisions');
});

test('batch scope mismatch is rejected atomically before the first revision is appended', async () => {
  const fixture = batchActionFixture();
  await assert.rejects(batchReturnCopyQa(fixture.pool, batchRequest({
    itemIds: [ITEM_A, ITEM_B],
    confirmedCount: 2,
    requestId: '22222222-2222-4222-8222-222222222222',
  }), reviewer), { code: 'BATCH_SCOPE_CHANGED' });
  assert.deepEqual(fixture.state.taskUpdates, []);
  assert.deepEqual(fixture.state.itemUpdates, []);
  assert.equal(fixture.state.queries.at(-1).sql, 'ROLLBACK');
});

test('reviewer batch action is switch-controlled while admin batch action remains available', async () => {
  const denied = batchActionFixture({ reviewerBatchReturnEnabled: false });
  await assert.rejects(batchReturnCopyQa(denied.pool, batchRequest(), reviewer), { code: 'FORBIDDEN' });
  assert.deepEqual(denied.state.taskUpdates, []);
  assert.ok(denied.state.queries.some(({ sql }) => sql
    === 'SELECT * FROM workflow_quality_settings WHERE singleton = 1 FOR SHARE'),
  'permission is rechecked under a transaction lock so revocation cannot race the commit');

  const allowed = batchActionFixture({ reviewerBatchReturnEnabled: false, blind: false });
  const result = await batchReturnCopyQa(allowed.pool, batchRequest(), admin);
  assert.deepEqual(result.taskIds, [101, 102, 103]);
});

test('batch return revalidates the active actor inside its transaction', async () => {
  const fixture = batchActionFixture({ actorActive: false });
  await assert.rejects(batchReturnCopyQa(fixture.pool, batchRequest(), reviewer), {
    code: 'SESSION_STALE',
  });
  assert.equal(fixture.state.queries.some(({ sql }) => sql.includes('workflow_quality_settings')), false);
  assert.equal(fixture.state.queries.at(-1).sql, 'ROLLBACK');
});

test('concurrent QA task locks fail fast as a retryable conflict instead of deadlocking', async () => {
  const fixture = batchActionFixture({ taskLockError: '55P03' });
  await assert.rejects(batchReturnCopyQa(fixture.pool, batchRequest(), reviewer), {
    code: 'QA_OPERATION_BUSY',
  });
  assert.equal(fixture.state.queries.at(-1).sql, 'ROLLBACK');
  assert.deepEqual(fixture.state.taskUpdates, []);
});

test('QA statistics use final approver accounts and separate verdicts, pending, mandatory and affected', async () => {
  const queries = [];
  const pool = { async query(sql) {
    const source = String(sql).replace(/\s+/gu, ' ').trim();
    queries.push(source);
    if (source.includes("WHERE item.sample_kind = 'RANDOM'")) return { rows: [
      { final_approver_account_id: '41', final_approver_username: 'approver-a', returned_count: '1', passed_count: '3', pending_count: '2' },
      { final_approver_account_id: '42', final_approver_username: 'approver-b', returned_count: '0', passed_count: '0', pending_count: '4' },
    ] };
    if (source.includes("sample_kind = 'MANDATORY_RECHECK'")) {
      return { rows: [{ passed_count: '2', returned_count: '1', pending_count: '1' }] };
    }
    if (source.includes("status = 'BATCH_AFFECTED'")) return { rows: [{ count: '7' }] };
    throw new Error(`unexpected SQL: ${source}`);
  } };

  const statistics = await getCopyQaStatistics(pool, admin);
  assert.deepEqual(statistics.random, [
    { finalApproverAccountId: 41, finalApproverUsername: 'approver-a', passed: 3, returned: 1, pending: 2, decided: 4, accuracyRate: 0.75 },
    { finalApproverAccountId: 42, finalApproverUsername: 'approver-b', passed: 0, returned: 0, pending: 4, decided: 0, accuracyRate: null },
  ]);
  assert.deepEqual(statistics.mandatory, { passed: 2, returned: 1, pending: 1 });
  assert.equal(statistics.batchAffectedCount, 7);

  assert.match(queries[0], /final_approver_account_id/u);
  assert.match(queries[0], /item\.selected = true/u);
  assert.match(queries[0], /item\.status = 'RETURNED'/u);
  assert.match(queries[0], /event\.action = 'PASS'/u);
  assert.doesNotMatch(queries[0], /status = 'NOT_SELECTED'[^)]*passed_count/u);
  await assert.rejects(getCopyQaStatistics(pool, reviewer), { code: 'FORBIDDEN' });
});
