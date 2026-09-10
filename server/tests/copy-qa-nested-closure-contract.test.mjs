import assert from 'node:assert/strict';
import test from 'node:test';

import { passCopyQaItem } from '../src/copy-quality-control.mjs';

const ITEM_ID = '30303030-3030-4030-8030-303030303030';
const TOKEN = 'a'.repeat(64);
const REQUEST_ID = '40404040-4040-4040-8040-404040404040';

function nestedRecheckFixture() {
  const state = {
    parentReads: [],
    releasedFreezeIds: [],
    releasedBatchIds: [],
    releasedTaskIds: [],
  };
  const current = {
    id: 30,
    public_id: ITEM_ID,
    freeze_id: 300,
    production_batch_id: 3_000,
    blind_review_enabled: true,
    final_approver_account_id: 72,
    task_id: 101,
    status: 'PENDING',
    task_state: 'COPY_QC_PENDING',
    copy_revision_id: 500,
    current_copy_revision_id: 500,
    content_sha256: TOKEN,
    sample_kind: 'MANDATORY_RECHECK',
    parent_item_id: 20,
  };
  const parents = new Map([
    [20, {
      id: 20,
      freeze_id: 200,
      freeze_status: 'REVIEW_REQUIRED',
      sample_kind: 'MANDATORY_RECHECK',
      status: 'RETURNED',
      parent_item_id: 10,
    }],
    [10, {
      id: 10,
      freeze_id: 100,
      freeze_status: 'REVIEW_REQUIRED',
      sample_kind: 'RANDOM',
      status: 'RETURNED',
      parent_item_id: null,
    }],
  ]);
  const batchByFreeze = new Map([[300, 3_000], [200, 2_000], [100, 1_000]]);
  const eligibleByFreeze = new Map([
    [300, [{ id: 30, task_id: 101 }]],
    [200, []],
    [100, [{ id: 11, task_id: 102 }, { id: 12, task_id: 103 }]],
  ]);
  const client = {
    release() {},
    async query(sql, values = []) {
      const source = String(sql).replace(/\s+/gu, ' ').trim();
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(source)) return { rows: [] };
      if (source.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [{}] };
      if (source.startsWith('SELECT id FROM app_users')) return { rows: [{ id: 91 }] };
      if (source.startsWith('SELECT id, task_id, freeze_id FROM copy_sampling_items')) {
        return { rows: [{ id: current.id, task_id: current.task_id, freeze_id: current.freeze_id }] };
      }
      if (source === 'SELECT * FROM tasks WHERE id = $1 FOR UPDATE') {
        return { rows: [{ id: current.task_id }] };
      }
      if (source === 'SELECT * FROM copy_sampling_freezes WHERE id = $1 FOR UPDATE') {
        return { rows: [{ id: current.freeze_id }] };
      }
      if (source.startsWith('SELECT item.*, sampling_freeze.status AS freeze_status')) {
        return { rows: [{ ...current }] };
      }
      if (source.startsWith('SELECT * FROM copy_sampling_mutation_requests')) return { rows: [] };
      if (source.startsWith("UPDATE copy_sampling_items SET status = 'PASSED'")) {
        current.status = 'PASSED';
        return { rows: [] };
      }
      if (source.startsWith('SELECT COUNT(*) AS count FROM copy_sampling_items')) {
        assert.match(source, /WITH RECURSIVE rechecks/u,
          'all returned ancestors must recognize a passing descendant at any depth');
        return { rows: [{ count: '0' }] };
      }
      if (source.startsWith('SELECT item.id, task.id AS task_id')) {
        return { rows: eligibleByFreeze.get(Number(values[0])) ?? [] };
      }
      if (source.startsWith("UPDATE tasks SET state = 'IMAGE_QUEUED'")) {
        state.releasedTaskIds.push(...values[0].map(Number));
        return { rows: [] };
      }
      if (source.startsWith("UPDATE copy_sampling_items SET status = 'RELEASED'")) return { rows: [] };
      if (source.startsWith('UPDATE copy_sampling_freezes SET status = $2')) {
        const freezeId = Number(values[0]);
        state.releasedFreezeIds.push(freezeId);
        return { rows: [{ production_batch_id: batchByFreeze.get(freezeId) }] };
      }
      if (source.startsWith('UPDATE production_batches SET status = $2')) {
        state.releasedBatchIds.push(Number(values[0]));
        return { rows: [] };
      }
      if (source.startsWith('SELECT parent.*, sampling_freeze.status AS freeze_status')) {
        const parentId = Number(values[0]);
        state.parentReads.push(parentId);
        const parent = parents.get(parentId);
        return { rows: parent ? [{ ...parent }] : [] };
      }
      if (source.startsWith('INSERT INTO copy_sampling_events')) return { rows: [] };
      if (source.startsWith('INSERT INTO copy_sampling_mutation_requests')) return { rows: [] };
      throw new Error(`unexpected SQL: ${source}`);
    },
  };
  return { state, pool: { connect: async () => client } };
}

test('a second mandatory repair pass recursively closes its first repair and original random freeze', async () => {
  const fixture = nestedRecheckFixture();
  const result = await passCopyQaItem(fixture.pool, ITEM_ID, {
    expectedRevisionToken: TOKEN,
    requestId: REQUEST_ID,
  }, { userId: 91, username: 'qa-reviewer', role: 'REVIEWER' });

  assert.deepEqual(fixture.state.parentReads, [20, 10]);
  assert.deepEqual(fixture.state.releasedFreezeIds, [300, 200, 100]);
  assert.deepEqual(fixture.state.releasedBatchIds, [3_000, 2_000, 1_000]);
  assert.deepEqual(fixture.state.releasedTaskIds, [101, 102, 103]);
  assert.deepEqual(result, { id: ITEM_ID, status: 'PASSED', releasedCount: 3 });
});
