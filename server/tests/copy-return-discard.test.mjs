import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { discardReturnedCopy } from '../src/copy-quality-control.mjs';

const TASK_ID = 101;
const RETURNED_REVISION_ID = 204;
const ITEM_PUBLIC_ID = '71717171-7171-4717-8717-717171717171';
const REQUEST_ID = '81818181-8181-4818-8818-818181818181';
const worker = Object.freeze({
  userId: 41,
  username: 'worker-41',
  role: 'USER',
  credentialVersion: 1,
});

function discardFixture({ recommendation = 'DISCARD', assignedTo = worker.username } = {}) {
  const state = {
    task: {
      id: TASK_ID,
      state: 'COPY_REVIEW_PENDING',
      current_stage: 'COPY_REVIEW_PENDING',
      mandatory_copy_qc: true,
      mandatory_copy_qc_origin: 'QA_RETURN',
      current_copy_revision_id: RETURNED_REVISION_ID,
      current_execution_id: null,
      assigned_to_user_id: assignedTo,
      production_batch_id: 27,
    },
    item: {
      id: 71,
      public_id: ITEM_PUBLIC_ID,
      task_id: TASK_ID,
      freeze_id: 18,
      status: 'RETURNED',
      sample_kind: 'RANDOM',
      parent_item_id: null,
      freeze_status: 'REVIEW_REQUIRED',
      production_batch_id: 27,
    },
    revision: {
      id: RETURNED_REVISION_ID,
      task_id: TASK_ID,
      revision_origin: 'QA_RETURN',
      content: {
        qualityReturn: {
          samplingItemId: ITEM_PUBLIC_ID,
          recommendedDisposition: recommendation,
        },
      },
    },
    receipts: new Map(),
    dispositions: [],
    releasedFreezeIds: [],
    releasedFreezeStatuses: [],
    queries: [],
  };
  const query = async (sql, values = []) => {
    const source = String(sql).replace(/\s+/gu, ' ').trim();
    state.queries.push({ sql: source, values });
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(source)) return { rows: [] };
    if (source.startsWith('SELECT id FROM app_users')) return { rows: [{ id: worker.userId }] };
    if (source.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [{}] };
    if (source.startsWith('SELECT * FROM copy_sampling_mutation_requests')) {
      const receipt = state.receipts.get(`${values[0]}:${values[1]}`);
      return { rows: receipt ? [structuredClone(receipt)] : [] };
    }
    if (source.startsWith('INSERT INTO copy_sampling_mutation_requests')) {
      state.receipts.set(`${values[0]}:${values[2]}`, {
        actor_account_id: values[0],
        actor_username: values[1],
        request_id: values[2],
        operation: values[3],
        request_fingerprint: values[4],
        response: structuredClone(values[5]),
      });
      return { rows: [] };
    }
    if (source.startsWith('SELECT id, task_id, freeze_id FROM copy_sampling_items')) {
      return { rows: [state.item] };
    }
    if (source === 'SELECT * FROM tasks WHERE id = $1 FOR UPDATE') return { rows: [state.task] };
    if (source === 'SELECT * FROM copy_sampling_freezes WHERE id = $1 FOR UPDATE') {
      return { rows: [{ id: state.item.freeze_id, status: state.item.freeze_status }] };
    }
    if (source.startsWith('SELECT item.*, sampling_freeze.status AS freeze_status')) {
      return { rows: [{ ...state.item }] };
    }
    if (source.startsWith('SELECT * FROM copy_revisions WHERE id = $1')) {
      return { rows: [state.revision] };
    }
    if (source.startsWith('INSERT INTO copy_return_dispositions')) {
      state.dispositions.push({
        taskId: values[0], revisionId: values[1], samplingItemId: values[2],
        reasonCode: values[3], note: values[4], actorAccountId: values[5], requestId: values[8],
      });
      return { rows: [{ id: 501, created_at: '2026-09-16T00:00:00.000Z' }] };
    }
    if (source.startsWith("UPDATE tasks SET state = 'CANCELLED'")) {
      state.task = {
        ...state.task,
        state: 'CANCELLED',
        current_stage: 'CANCELLED',
        cancelled_from_state: 'COPY_REVIEW_PENDING',
      };
      return { rows: [state.task] };
    }
    if (source.startsWith('SELECT COUNT(*) AS count FROM copy_sampling_items')) {
      return { rows: [{ count: '0' }] };
    }
    if (source.startsWith('SELECT item.id, task.id AS task_id')) return { rows: [] };
    if (source.startsWith('UPDATE copy_sampling_freezes SET status = $2')) {
      state.releasedFreezeIds.push(Number(values[0]));
      state.releasedFreezeStatuses.push(values[1]);
      state.item.freeze_status = values[1];
      return { rows: [{ production_batch_id: 27 }] };
    }
    if (source.startsWith('UPDATE production_batches SET status = $2')) return { rows: [] };
    if (source.startsWith('INSERT INTO copy_sampling_events')) return { rows: [] };
    if (source.startsWith("UPDATE tasks task SET state = 'IMAGE_QUEUED'")) return { rows: [] };
    throw new Error(`unexpected SQL: ${source}`);
  };
  const client = { query, release() {} };
  return { state, pool: { connect: async () => client } };
}

const input = Object.freeze({
  requestId: REQUEST_ID,
  expectedCopyRevisionId: RETURNED_REVISION_ID,
  sourceSamplingItemId: ITEM_PUBLIC_ID,
  reasonCode: 'QA_RECOMMENDATION',
  note: '已核对质检问题，继续返工无法满足本次选题要求',
});

test('assigned worker can discard a QA-returned copy without rewriting the RETURNED verdict', async () => {
  const fixture = discardFixture();
  const result = await discardReturnedCopy(fixture.pool, TASK_ID, input, worker);

  assert.equal(result.status, 'DISCARDED');
  assert.equal(result.task.state, 'CANCELLED');
  assert.equal(fixture.state.item.status, 'RETURNED');
  assert.deepEqual(fixture.state.dispositions, [{
    taskId: TASK_ID,
    revisionId: RETURNED_REVISION_ID,
    samplingItemId: 71,
    reasonCode: 'QA_RECOMMENDATION',
    note: input.note,
    actorAccountId: worker.userId,
    requestId: REQUEST_ID,
  }]);
  assert.deepEqual(fixture.state.releasedFreezeIds, [18],
    'a one-item returned freeze must close instead of remaining stuck');
  assert.deepEqual(fixture.state.releasedFreezeStatuses, ['RELEASED_WITH_EXCEPTIONS'],
    'discard is a business exception rather than a QA pass');

  const replay = await discardReturnedCopy(fixture.pool, TASK_ID, input, worker);
  assert.deepEqual(replay, result);
  assert.equal(fixture.state.dispositions.length, 1, 'same request must be idempotent');
});

test('non-owner cannot discard another workers returned copy', async () => {
  const fixture = discardFixture({ assignedTo: 'worker-else' });
  await assert.rejects(
    discardReturnedCopy(fixture.pool, TASK_ID, input, worker),
    { code: 'FORBIDDEN' },
  );
  assert.equal(fixture.state.dispositions.length, 0);
});

test('QA_RECOMMENDATION reason requires an actual discard recommendation', async () => {
  const fixture = discardFixture({ recommendation: 'REWORK' });
  await assert.rejects(
    discardReturnedCopy(fixture.pool, TASK_ID, input, worker),
    { code: 'QA_DISCARD_NOT_RECOMMENDED' },
  );
  assert.equal(fixture.state.dispositions.length, 0);
});

test('worker cannot bypass a rework-only QA decision with another reason code', async () => {
  const fixture = discardFixture({ recommendation: 'REWORK' });
  await assert.rejects(
    discardReturnedCopy(fixture.pool, TASK_ID, {
      ...input,
      reasonCode: 'UNRECOVERABLE_QUALITY',
    }, worker),
    { code: 'QA_DISCARD_NOT_RECOMMENDED' },
  );
  assert.equal(fixture.state.dispositions.length, 0);
});

test('copy-return disposition migration keeps QA verdicts separate and extends idempotency receipts', async () => {
  const sql = await readFile(new URL('../migrations/0062_copy_return_dispositions.sql', import.meta.url), 'utf8');
  assert.match(sql, /CREATE TABLE copy_return_dispositions/u);
  assert.match(sql, /source_sampling_item_id bigint NOT NULL REFERENCES copy_sampling_items\(id\)/u);
  assert.match(sql, /action = 'DISCARD_AFTER_QA_RETURN'/u);
  assert.match(sql, /UNIQUE\(task_id, returned_revision_id\)/u);
  assert.match(sql, /'ADMIN_DIRECT_PASS'/u, 'the existing admin-direct receipt type must remain valid');
  assert.match(sql, /'DISCARD_REWORK'/u);
  assert.doesNotMatch(sql, /UPDATE\s+copy_sampling_items|DELETE\s+FROM\s+copy_sampling_items/iu);
});
