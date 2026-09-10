import assert from 'node:assert/strict';
import test from 'node:test';

import {
  passCopyQaItem,
  releaseCopyQaFreeze,
  routeManualCopyApproval,
} from '../src/copy-quality-control.mjs';

const ITEM_ID = '71717171-7171-4717-8717-717171717171';
const FREEZE_PUBLIC_ID = '81818181-8181-4818-8818-818181818181';
const reviewer = Object.freeze({ userId: 91, username: 'qa-reviewer', role: 'REVIEWER' });

function mandatoryRecheckFixture() {
  const state = {
    taskState: 'COPY_REVIEW_PENDING',
    currentRevisionId: 204,
    mandatory: true,
    item: null,
    itemStatus: null,
    syntheticBatchId: null,
    syntheticFreezeId: null,
    syntheticBlindReviewEnabled: null,
    syntheticPolicyVersion: null,
    originalBusinessBatchId: 27,
    releasedFreezeIds: [],
    releasedBatchIds: [],
    queries: [],
    releasedTaskIds: [],
  };
  const query = async (sql, values = []) => {
    const source = String(sql).replace(/\s+/gu, ' ').trim();
    state.queries.push({ sql: source, values });
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(source)) return { rows: [] };
    if (source.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [{}] };
    if (source.startsWith('INSERT INTO copy_approval_events')) {
      return { rows: [{
        id: 704,
        task_id: Number(values[0]),
        copy_revision_id: Number(values[1]),
        assessment_id: Number(values[2]),
        approved_by_account_id: Number(values[4]),
        approved_by_username: values[5],
        content_sha256: values[7],
      }] };
    }
    if (source.startsWith('SELECT item.*, sampling_freeze.production_batch_id')) {
      return { rows: [{
        id: 11,
        public_id: '11111111-1111-4111-8111-111111111111',
        freeze_id: 18,
        production_batch_id: 27,
        status: 'RETURNED',
        freeze_status: 'REVIEW_REQUIRED',
        parent_policy_version: 17,
        parent_blind_review_enabled: true,
      }] };
    }
    if (source === 'SELECT * FROM workflow_quality_settings WHERE singleton = 1 FOR SHARE') {
      return { rows: [{
        singleton: 1,
        version: 23,
        copy_sampling_enabled: true,
        copy_sampling_rate_bps: 2500,
        blind_review_enabled: false,
        reviewer_batch_return_enabled: false,
        query_package_worker_import_enabled: false,
        sampling_seed: 'copy-sampling-v1',
      }] };
    }
    if (source.startsWith('INSERT INTO production_batches')) {
      state.syntheticBatchId = 88;
      return { rows: [{ id: state.syntheticBatchId, public_id: values[0], status: 'FROZEN', sampling_status: 'FROZEN' }] };
    }
    if (source.startsWith('INSERT INTO copy_sampling_freezes')) {
      state.syntheticFreezeId = 99;
      state.syntheticPolicyVersion = Number(values[2]);
      state.syntheticBlindReviewEnabled = values[4];
      return { rows: [{
        id: state.syntheticFreezeId,
        public_id: values[0],
        production_batch_id: state.syntheticBatchId,
        status: 'REVIEW_REQUIRED',
      }] };
    }
    if (source.startsWith('INSERT INTO copy_sampling_items')) {
      state.item = {
        id: 14,
        public_id: ITEM_ID,
        freeze_id: Number(values[1]),
        task_id: Number(values[2]),
        approval_event_id: Number(values[3]),
        copy_revision_id: Number(values[4]),
        content_sha256: values[5],
        final_approver_account_id: Number(values[6]),
        final_approver_username: values[7],
        rank_hash: values[8],
        selected: true,
        sample_kind: 'MANDATORY_RECHECK',
        parent_item_id: values[9] === null ? null : Number(values[9]),
        status: 'PENDING',
        blind_review_enabled: true,
        production_batch_id: state.syntheticBatchId,
      };
      state.itemStatus = 'PENDING';
      return { rows: [{ ...state.item }] };
    }
    if (source.startsWith("UPDATE production_batches SET status = 'REVIEW_REQUIRED'")) return { rows: [] };
    if (source.startsWith("UPDATE tasks SET state = 'COPY_QC_PENDING'")) {
      state.taskState = 'COPY_QC_PENDING';
      state.currentRevisionId = Number(values[2]);
      return { rows: [{
        id: Number(values[0]), state: state.taskState, current_copy_revision_id: state.currentRevisionId,
        mandatory_copy_qc: true, production_batch_id: state.originalBusinessBatchId,
      }] };
    }
    if (source.startsWith('SELECT item.*, sampling_freeze.status AS freeze_status')) {
      return { rows: [{
        ...state.item,
        status: state.itemStatus,
        task_state: state.taskState,
        current_copy_revision_id: state.currentRevisionId,
      }] };
    }
    if (source.startsWith('SELECT id FROM app_users')) return { rows: [{ id: reviewer.userId }] };
    if (source.startsWith('SELECT id, task_id, freeze_id FROM copy_sampling_items')) {
      return { rows: [{ id: state.item.id, task_id: state.item.task_id, freeze_id: state.item.freeze_id }] };
    }
    if (source === 'SELECT * FROM tasks WHERE id = $1 FOR UPDATE') {
      return { rows: [{ id: state.item.task_id }] };
    }
    if (source === 'SELECT * FROM copy_sampling_freezes WHERE id = $1 FOR UPDATE') {
      return { rows: [{ id: state.item.freeze_id }] };
    }
    if (source.startsWith('SELECT parent.*, sampling_freeze.status AS freeze_status')) {
      return { rows: [{
        id: 11,
        freeze_id: 18,
        task_id: 101,
        copy_revision_id: 203,
        status: 'RETURNED',
        sample_kind: 'RANDOM',
        freeze_status: 'REVIEW_REQUIRED',
      }] };
    }
    if (source.startsWith('SELECT * FROM copy_sampling_mutation_requests')) return { rows: [] };
    if (source.startsWith("UPDATE copy_sampling_items SET status = 'PASSED'")) {
      state.itemStatus = 'PASSED';
      return { rows: [] };
    }
    if (source.startsWith('SELECT COUNT(*) AS count FROM copy_sampling_items')) return { rows: [{ count: '0' }] };
    if (source.startsWith('SELECT item.id, task.id AS task_id')) {
      return Number(values[0]) === state.syntheticFreezeId
        ? { rows: [{ id: state.item.id, task_id: state.item.task_id }] }
        : { rows: [] };
    }
    if (source.startsWith("UPDATE tasks SET state = 'IMAGE_QUEUED'")) {
      state.taskState = 'IMAGE_QUEUED';
      state.mandatory = false;
      state.releasedTaskIds.push(...values[0].map(Number));
      return { rows: [] };
    }
    if (source.startsWith("UPDATE copy_sampling_items SET status = 'RELEASED'")) return { rows: [] };
    if (source.startsWith('UPDATE copy_sampling_freezes SET status = $2')) {
      state.releasedFreezeIds.push(Number(values[0]));
      return { rows: [{
        production_batch_id: Number(values[0]) === state.syntheticFreezeId
          ? state.syntheticBatchId : state.originalBusinessBatchId,
      }] };
    }
    if (source.startsWith('UPDATE production_batches SET status = $2')) {
      state.releasedBatchIds.push(Number(values[0]));
      return { rows: [] };
    }
    if (source.startsWith('INSERT INTO copy_sampling_events')) return { rows: [] };
    if (source.startsWith('INSERT INTO copy_sampling_mutation_requests')) return { rows: [] };
    throw new Error(`unexpected SQL: ${source}`);
  };
  const client = { query, release() {} };
  return { state, client, pool: { connect: async () => client } };
}

test('returned copy approval creates a mandatory recheck whose PASS finally releases the task', async () => {
  const fixture = mandatoryRecheckFixture();
  const worker = { userId: 41, username: 'worker-41', role: 'USER' };
  const revision = {
    id: 204,
    content: { copy: { title: '已按退回意见修正', body: '修正后的正文', tags: [] } },
  };
  const routed = await routeManualCopyApproval(fixture.client, {
    task: {
      id: 101,
      query: '测试 Query',
      mandatory_copy_qc: true,
      mandatory_copy_qc_origin: 'QA_RETURN',
      production_batch_id: 27,
    },
    revision,
    assessment: { id: 604, scoreX10: 30 },
    actor: worker,
    reviewSessionId: '44444444-4444-4444-8444-444444444444',
    aiDisclosureEnabled: true,
  });

  assert.equal(routed.task.state, 'COPY_QC_PENDING');
  assert.equal(routed.samplingItem.sample_kind, 'MANDATORY_RECHECK');
  assert.equal(routed.samplingItem.parent_item_id, 11);
  assert.equal(fixture.state.item.copy_revision_id, revision.id);
  assert.equal(fixture.state.item.freeze_id, fixture.state.syntheticFreezeId);
  assert.equal(fixture.state.syntheticBlindReviewEnabled, true,
    'the mandatory round inherits blind review from its parent freeze');
  assert.equal(fixture.state.syntheticPolicyVersion, 17,
    'the mandatory round keeps the parent policy version with its inherited blind boundary');
  const mandatoryFreezeInsert = fixture.state.queries.find(({ sql }) => sql.startsWith('INSERT INTO copy_sampling_freezes'));
  assert.match(mandatoryFreezeInsert.sql, /\$5, 1, 1/u);
  assert.doesNotMatch(mandatoryFreezeInsert.sql, /workflow_quality_settings/u,
    'a later global setting change cannot alter the inherited blind-review boundary');
  assert.notEqual(fixture.state.syntheticBatchId, fixture.state.originalBusinessBatchId,
    'mandatory recheck must use an isolated QA batch');
  assert.equal(routed.task.production_batch_id, fixture.state.originalBusinessBatchId,
    'the synthetic QA batch must not replace the task business batch');

  const passed = await passCopyQaItem(fixture.pool, ITEM_ID, {
    expectedRevisionToken: fixture.state.item.content_sha256,
    requestId: '55555555-5555-4555-8555-555555555555',
  }, reviewer);
  assert.deepEqual(passed, { id: ITEM_ID, status: 'PASSED', releasedCount: 1 });
  assert.equal(fixture.state.taskState, 'IMAGE_QUEUED');
  assert.equal(fixture.state.mandatory, false);
  assert.deepEqual(fixture.state.releasedTaskIds, [101]);
  assert.equal(fixture.state.itemStatus, 'PASSED', 'mandatory verdict remains countable after release');
  assert.deepEqual(fixture.state.releasedFreezeIds, [fixture.state.syntheticFreezeId, 18]);
  assert.deepEqual(fixture.state.releasedBatchIds, [fixture.state.syntheticBatchId, fixture.state.originalBusinessBatchId]);
});

for (const reworkTarget of ['COPY', 'BOTH']) {
  test(`final ${reworkTarget} rework creates an independent mandatory round from the live blind policy`, async () => {
    const fixture = mandatoryRecheckFixture();
    const worker = { userId: 41, username: 'worker-41', role: 'USER' };
    const revision = {
      id: 304,
      content: {
        copy: { title: '终审返工后文案', body: '已经真实修改正文', tags: [] },
        finalRework: { target: reworkTarget, reasonCodes: ['CONTENT_MISMATCH'] },
      },
    };

    const routed = await routeManualCopyApproval(fixture.client, {
      task: {
        id: 101,
        mandatory_copy_qc: true,
        mandatory_copy_qc_origin: 'FINAL_REWORK',
        production_batch_id: null,
      },
      revision,
      assessment: { id: 804, scoreX10: 30 },
      actor: worker,
      reviewSessionId: reworkTarget === 'COPY'
        ? '94949494-9494-4494-8494-949494949494'
        : '95959595-9595-4595-8595-959595959595',
      aiDisclosureEnabled: true,
    });

    assert.equal(routed.task.state, 'COPY_QC_PENDING');
    assert.equal(routed.samplingItem.sample_kind, 'MANDATORY_RECHECK');
    assert.equal(routed.samplingItem.parent_item_id, null,
      'final-review rework must not attach to an old random-sampling return');
    assert.equal(fixture.state.syntheticPolicyVersion, 23);
    assert.equal(fixture.state.syntheticBlindReviewEnabled, false);
    assert.equal(fixture.state.queries.some(({ sql }) => sql
      .startsWith('SELECT item.*, sampling_freeze.production_batch_id')), false,
    'FINAL_REWORK must not search for or reuse a historical returned item');
    assert.ok(fixture.state.queries.some(({ sql }) => sql
      === 'SELECT * FROM workflow_quality_settings WHERE singleton = 1 FOR SHARE'));
  });
}

test('a synthetic mandatory round cannot be bypassed through release-rest', async () => {
  const calls = [];
  const client = {
    release() {},
    async query(sql, values = []) {
      const source = String(sql).replace(/\s+/gu, ' ').trim();
      calls.push({ sql: source, values });
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(source)) return { rows: [] };
      if (source.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [{}] };
      if (source.startsWith('SELECT id FROM app_users')) return { rows: [{ id: reviewer.userId }] };
      if (source.startsWith('SELECT id FROM copy_sampling_freezes')) return { rows: [{ id: 99 }] };
      if (source.startsWith('SELECT task.id FROM copy_sampling_items')) return { rows: [] };
      if (source.startsWith('SELECT * FROM copy_sampling_freezes') && source.includes('WHERE id = $1')) {
        return { rows: [{ id: 99, public_id: FREEZE_PUBLIC_ID, status: 'REVIEW_REQUIRED', blind_review_enabled: true }] };
      }
      if (source.startsWith('SELECT * FROM copy_sampling_mutation_requests')) return { rows: [] };
      if (source.startsWith('SELECT COUNT(*) FILTER')) return { rows: [{ returned_random_count: '0' }] };
      throw new Error(`unexpected SQL: ${source}`);
    },
  };

  await assert.rejects(releaseCopyQaFreeze({ connect: async () => client }, FREEZE_PUBLIC_ID, {
    note: '错误尝试跳过强制复检',
    requestId: '91919191-9191-4919-8919-919191919191',
  }, reviewer), { code: 'BATCH_NOT_RELEASABLE' });
  assert.equal(calls.some(({ sql }) => sql.startsWith('SELECT item.id, task.id AS task_id')), false);
  assert.equal(calls.some(({ sql }) => sql.startsWith('UPDATE tasks SET')), false);
  assert.equal(calls.at(-1).sql, 'ROLLBACK');
});

test('release-rest excludes an unresolved returned task and updates only eligible member ids', async () => {
  const calls = [];
  const releasedTaskIds = [];
  const releasedItemIds = [];
  const client = {
    release() {},
    async query(sql, values = []) {
      const source = String(sql).replace(/\s+/gu, ' ').trim();
      calls.push({ sql: source, values });
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(source)) return { rows: [] };
      if (source.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [{}] };
      if (source.startsWith('SELECT id FROM app_users')) return { rows: [{ id: reviewer.userId }] };
      if (source.startsWith('SELECT id FROM copy_sampling_freezes')) return { rows: [{ id: 18 }] };
      if (source.startsWith('SELECT task.id FROM copy_sampling_items')) return { rows: [] };
      if (source.startsWith('SELECT * FROM copy_sampling_freezes') && source.includes('WHERE id = $1')) {
        return { rows: [{
          id: 18, public_id: FREEZE_PUBLIC_ID, production_batch_id: 27,
          status: 'REVIEW_REQUIRED', blind_review_enabled: true,
        }] };
      }
      if (source.startsWith('SELECT * FROM copy_sampling_mutation_requests')) return { rows: [] };
      if (source.startsWith('SELECT COUNT(*) FILTER')) return { rows: [{ returned_random_count: '1' }] };
      if (source.startsWith('SELECT item.id, task.id AS task_id')) {
        assert.match(source, /returned\.status IN \('RETURNED', 'BATCH_AFFECTED', 'BATCH_RETURNED'\)/u);
        assert.match(source, /recheck\.sample_kind = 'MANDATORY_RECHECK'[\s\S]*recheck\.status IN \('PASSED', 'RELEASED'\)/u);
        return { rows: [{ id: 21, task_id: 102 }] };
      }
      if (source.startsWith("UPDATE tasks SET state = 'IMAGE_QUEUED'")) {
        releasedTaskIds.push(...values[0].map(Number));
        return { rows: [] };
      }
      if (source.startsWith("UPDATE copy_sampling_items SET status = 'RELEASED'")) {
        releasedItemIds.push(...values[0].map(Number));
        return { rows: [] };
      }
      if (source.startsWith('UPDATE copy_sampling_freezes SET status = $2')) {
        return { rows: [{ production_batch_id: 27 }] };
      }
      if (source.startsWith('UPDATE production_batches SET status = $2')) return { rows: [] };
      if (source.startsWith('INSERT INTO copy_sampling_events')) return { rows: [] };
      if (source.startsWith('INSERT INTO copy_sampling_mutation_requests')) return { rows: [] };
      throw new Error(`unexpected SQL: ${source}`);
    },
  };

  const result = await releaseCopyQaFreeze({ connect: async () => client }, FREEZE_PUBLIC_ID, {
    note: '退回项继续返工，只放行无关等待成员',
    requestId: '92929292-9292-4929-8929-929292929292',
  }, reviewer);
  assert.deepEqual(result, {
    freezePublicId: FREEZE_PUBLIC_ID,
    status: 'RELEASED_WITH_EXCEPTIONS',
    releasedCount: 1,
  });
  assert.deepEqual(releasedTaskIds, [102]);
  assert.deepEqual(releasedItemIds, [21], 'status updates are scoped to the locked eligible rows, not the whole freeze');
});
