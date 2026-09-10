import assert from 'node:assert/strict';
import test from 'node:test';

import { passCopyQaItem, returnCopyQaItem } from '../src/copy-quality-control.mjs';

const ITEM_ID = '71717171-7171-4717-8717-717171717171';
const REVISION_TOKEN = 'a'.repeat(64);
const reviewer = Object.freeze({ userId: 91, username: 'qa-reviewer', role: 'REVIEWER' });

function actionFixture() {
  const state = {
    item: {
      id: 71,
      public_id: ITEM_ID,
      freeze_id: 18,
      production_batch_id: 27,
      blind_review_enabled: true,
      final_approver_account_id: 64,
      final_approver_username: 'SECRET-APPROVER',
      task_id: 991,
      status: 'PENDING',
      task_state: 'COPY_QC_PENDING',
      copy_revision_id: 902,
      current_copy_revision_id: 902,
      content_sha256: REVISION_TOKEN,
    },
    revision: {
      id: 902,
      task_id: 991,
      revision: 4,
      content: { copy: { title: '最终人工通过版本', body: '正文', tags: [] } },
      copy_content_changed_from_machine: true,
    },
    queries: [],
    updates: [],
    mutations: new Map(),
    activeActor: reviewer,
  };
  const query = async (sql, values = []) => {
    const source = String(sql).replace(/\s+/gu, ' ').trim();
    state.queries.push({ sql: source, values });
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(source)) return { rows: [] };
    if (source.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [{}] };
    if (source.startsWith('SELECT id FROM app_users')) {
      return { rows: Number(values[0]) === state.activeActor.userId
          && values[1] === state.activeActor.username && values[2] === state.activeActor.role
        ? [{ id: state.activeActor.userId }] : [] };
    }
    if (source.startsWith('SELECT id, task_id, freeze_id FROM copy_sampling_items')) {
      return { rows: [{ id: state.item.id, task_id: state.item.task_id, freeze_id: state.item.freeze_id }] };
    }
    if (source === 'SELECT * FROM tasks WHERE id = $1 FOR UPDATE') {
      return { rows: [{ id: state.item.task_id }] };
    }
    if (source === 'SELECT * FROM copy_sampling_freezes WHERE id = $1 FOR UPDATE') {
      return { rows: [{ id: state.item.freeze_id }] };
    }
    if (source.startsWith('SELECT item.*, sampling_freeze.status AS freeze_status')) {
      return { rows: [{ ...state.item }] };
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
    if (source.startsWith("UPDATE copy_sampling_items SET status = 'PASSED'")) {
      state.updates.push('PASS');
      return { rows: [] };
    }
    if (source.startsWith('INSERT INTO copy_sampling_events')) return { rows: [] };
    if (source.startsWith('SELECT COUNT(*) AS count FROM copy_sampling_items')) {
      return { rows: [{ count: '1' }] };
    }
    if (source.startsWith('SELECT * FROM copy_revisions WHERE id = $1')) {
      return { rows: [{ ...state.revision }] };
    }
    if (source.startsWith('SELECT COALESCE(MAX(revision), 0) + 1 AS revision')) {
      return { rows: [{ revision: '5' }] };
    }
    if (source.startsWith('INSERT INTO copy_revisions')) {
      state.updates.push('RETURN_REVISION');
      return { rows: [{ ...state.revision, id: 903, revision: 5, content: values[2], approved_at: null }] };
    }
    if (source.startsWith("UPDATE tasks SET state = 'COPY_REVIEW_PENDING'")) {
      state.updates.push('RETURN_TASK');
      return { rows: [] };
    }
    if (source.startsWith("UPDATE copy_sampling_items SET status = 'RETURNED'")) {
      state.updates.push('RETURN_ITEM');
      return { rows: [] };
    }
    if (source.startsWith("UPDATE copy_sampling_freezes SET status = 'REVIEW_REQUIRED'")) return { rows: [] };
    if (source.startsWith("UPDATE production_batches SET status = 'REVIEW_REQUIRED'")) return { rows: [] };
    throw new Error(`unexpected SQL: ${source}`);
  };
  const client = { query, release() {} };
  return { state, pool: { connect: async () => client } };
}

function assertBlindActionResponse(response, expectedStatus) {
  assert.deepEqual(response, { id: ITEM_ID, status: expectedStatus, ...(expectedStatus === 'PASSED' ? { releasedCount: 0 } : {}) });
  assert.deepEqual(Object.values(response).filter((value) => typeof value === 'number'),
    expectedStatus === 'PASSED' ? [0] : [], 'only the aggregate releasedCount may be numeric');
  for (const forbiddenKey of ['taskId', 'copyRevisionId', 'productionBatchId', 'freezeId', 'releasedTaskIds']) {
    assert.equal(Object.hasOwn(response, forbiddenKey), false, forbiddenKey);
  }
}

test('blind pass accepts the opaque final-revision token and returns no numeric identifiers', async () => {
  const fixture = actionFixture();
  const input = {
    expectedRevisionToken: REVISION_TOKEN,
    requestId: '11111111-1111-4111-8111-111111111111',
  };
  const passed = await passCopyQaItem(fixture.pool, ITEM_ID, input, reviewer);
  assertBlindActionResponse(passed, 'PASSED');
  const replay = await passCopyQaItem(fixture.pool, ITEM_ID, input, reviewer);
  assert.deepEqual(replay, passed);
  assert.equal(fixture.state.updates.filter((item) => item === 'PASS').length, 1);
  const actorLock = fixture.state.queries.findIndex(({ sql }) => sql.startsWith('SELECT id FROM app_users'));
  const locationRead = fixture.state.queries.findIndex(({ sql }) => sql.startsWith('SELECT id, task_id, freeze_id'));
  const taskLock = fixture.state.queries.findIndex(({ sql }) => sql === 'SELECT * FROM tasks WHERE id = $1 FOR UPDATE');
  const freezeLock = fixture.state.queries.findIndex(({ sql }) => sql === 'SELECT * FROM copy_sampling_freezes WHERE id = $1 FOR UPDATE');
  const itemLock = fixture.state.queries.findIndex(({ sql }) => sql.startsWith('SELECT item.*, sampling_freeze.status AS freeze_status'));
  assert.ok(actorLock < locationRead && locationRead < taskLock && taskLock < freezeLock && freezeLock < itemLock,
    'single-item QA locks the actor, task, freeze and item in a stable order');
});

test('a same-name replacement reviewer cannot replay the former account receipt', async () => {
  const fixture = actionFixture();
  const requestId = '12121212-1212-4212-8212-121212121212';
  fixture.state.mutations.set(`${reviewer.userId}:${requestId}`, {
    actor_account_id: reviewer.userId,
    actor_username: reviewer.username,
    request_id: requestId,
    operation: 'PASS',
    request_fingerprint: 'former-account-fingerprint',
    response: { sentinel: 'former-account-response' },
  });
  const replacement = { ...reviewer, userId: reviewer.userId + 1 };
  fixture.state.activeActor = replacement;

  const passed = await passCopyQaItem(fixture.pool, ITEM_ID, {
    expectedRevisionToken: REVISION_TOKEN,
    requestId,
  }, replacement);

  assertBlindActionResponse(passed, 'PASSED');
  assert.equal(fixture.state.updates.filter((item) => item === 'PASS').length, 1);
  assert.equal(fixture.state.mutations.get(`${reviewer.userId}:${requestId}`).response.sentinel,
    'former-account-response');
  assert.deepEqual(fixture.state.mutations.get(`${replacement.userId}:${requestId}`).response, passed);
});

test('single return is always available to a reviewer and creates a mandatory-recheck revision', async () => {
  const fixture = actionFixture();
  const returned = await returnCopyQaItem(fixture.pool, ITEM_ID, {
    expectedRevisionToken: REVISION_TOKEN,
    reasonCodes: ['FACT_ERROR'],
    note: '事实数据与最终来源不一致',
    requestId: '22222222-2222-4222-8222-222222222222',
  }, reviewer);

  assertBlindActionResponse(returned, 'RETURNED');
  assert.deepEqual(fixture.state.updates, ['RETURN_REVISION', 'RETURN_TASK', 'RETURN_ITEM']);
  const taskUpdate = fixture.state.queries.find(({ sql }) => sql.startsWith("UPDATE tasks SET state = 'COPY_REVIEW_PENDING'"));
  assert.match(taskUpdate.sql, /mandatory_copy_qc = true/u);
  assert.match(taskUpdate.sql, /mandatory_copy_qc_origin = 'QA_RETURN'/u);
  assert.equal(fixture.state.queries.some(({ sql }) => sql.includes('workflow_quality_settings')), false,
    'the reviewer batch-return switch must never disable a single-item return');
});

test('stale opaque revision tokens fail before any copy or task mutation', async () => {
  const fixture = actionFixture();
  await assert.rejects(returnCopyQaItem(fixture.pool, ITEM_ID, {
    expectedRevisionToken: 'b'.repeat(64),
    reasonCodes: ['FACT_ERROR'],
    requestId: '33333333-3333-4333-8333-333333333333',
  }, reviewer), { code: 'STALE_QA_ITEM' });
  assert.deepEqual(fixture.state.updates, []);
});

test('a reviewer cannot pass or return their own final approval', async () => {
  for (const operation of ['pass', 'return']) {
    const fixture = actionFixture();
    fixture.state.item.final_approver_account_id = reviewer.userId;
    const input = {
      expectedRevisionToken: REVISION_TOKEN,
      reasonCodes: operation === 'return' ? ['FACT_ERROR'] : [],
      requestId: operation === 'pass'
        ? '44444444-4444-4444-8444-444444444444'
        : '55555555-5555-4555-8555-555555555555',
    };
    const call = operation === 'pass' ? passCopyQaItem : returnCopyQaItem;
    await assert.rejects(call(fixture.pool, ITEM_ID, input, reviewer), { code: 'FORBIDDEN' });
    assert.deepEqual(fixture.state.updates, []);
  }
});
