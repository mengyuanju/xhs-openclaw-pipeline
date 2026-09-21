import assert from 'node:assert/strict';
import test from 'node:test';

import {
  batchReturnCopyQa,
  getCopyQaBatchReturnPreview,
} from '../src/copy-quality-control.mjs';

const FREEZE_ID = '11111111-1111-4111-8111-111111111111';
const TRIGGER_ID = '22222222-2222-4222-8222-222222222222';
const PENDING_ID = '33333333-3333-4333-8333-333333333333';
const HELD_ID = '44444444-4444-4444-8444-444444444444';

function singleToBatchFixture() {
  const token = (letter) => letter.repeat(64);
  const freeze = {
    id: 18,
    public_id: FREEZE_ID,
    production_batch_id: 27,
    status: 'REVIEW_REQUIRED',
    blind_review_enabled: true,
    snapshot_sha256: token('f'),
    version: 2,
  };
  const items = [
    {
      id: 71, public_id: TRIGGER_ID, freeze_id: 18, task_id: 991,
      copy_revision_id: 901, current_copy_revision_id: 999,
      content_sha256: token('a'), final_approver_account_id: 64,
      selected: true, sample_kind: 'RANDOM', status: 'RETURNED',
      task_state: 'COPY_REVIEW_PENDING', reason_codes: ['FACT_ERROR'],
    },
    {
      id: 72, public_id: PENDING_ID, freeze_id: 18, task_id: 992,
      copy_revision_id: 902, current_copy_revision_id: 902,
      content_sha256: token('b'), final_approver_account_id: 65,
      selected: true, sample_kind: 'RANDOM', status: 'PENDING',
      task_state: 'COPY_QC_PENDING',
    },
    {
      id: 73, public_id: HELD_ID, freeze_id: 18, task_id: 993,
      copy_revision_id: 903, current_copy_revision_id: 903,
      content_sha256: token('c'), final_approver_account_id: 66,
      selected: false, sample_kind: 'RANDOM', status: 'NOT_SELECTED',
      task_state: 'COPY_QC_PENDING',
    },
  ];
  const state = { returnedRevisionTaskIds: [], itemUpdates: [], eventDetails: null };
  const client = {
    release() {},
    async query(sql, values = []) {
      const source = String(sql).replace(/\s+/gu, ' ').trim();
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(source)) return { rows: [] };
      if (source.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [{}] };
      if (source.startsWith('SELECT id FROM app_users')) return { rows: [{ id: Number(values[0]) }] };
      if (source.startsWith('SELECT * FROM workflow_quality_settings WHERE singleton = 1')) {
        return { rows: [{
          version: 1,
          copy_sampling_enabled: true,
          copy_sampling_rate_bps: 1_000,
          blind_review_enabled: true,
          reviewer_batch_return_enabled: true,
          sampling_seed: 'test',
        }] };
      }
      if (source.startsWith('SELECT sampling_freeze.*, batch.public_id AS batch_public_id')) {
        return { rows: [{ ...freeze, batch_public_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }] };
      }
      if (source.startsWith('SELECT id FROM copy_sampling_freezes')) return { rows: [{ id: freeze.id }] };
      if (source.startsWith('SELECT task.id FROM copy_sampling_items')) return { rows: [] };
      if (source.startsWith('SELECT * FROM copy_sampling_freezes') && source.includes('WHERE id = $1')) {
        return { rows: [{ ...freeze }] };
      }
      if (source.startsWith('SELECT item.*, task.state AS task_state')) {
        return { rows: items.map((item) => ({ ...item })) };
      }
      if (source.startsWith('SELECT * FROM copy_sampling_mutation_requests')) return { rows: [] };
      if (source.startsWith('SELECT * FROM copy_revisions WHERE id = $1')) {
        const item = items.find((candidate) => candidate.copy_revision_id === Number(values[0]));
        return { rows: [{
          id: item.copy_revision_id,
          task_id: item.task_id,
          revision: 1,
          content: { copy: { title: `任务${item.task_id}`, body: '正文', tags: [] } },
          copy_content_changed_from_machine: true,
        }] };
      }
      if (source.startsWith('SELECT COALESCE(MAX(revision), 0) + 1 AS revision')) {
        return { rows: [{ revision: 2 }] };
      }
      if (source.startsWith('INSERT INTO copy_revisions')) {
        state.returnedRevisionTaskIds.push(Number(values[0]));
        return { rows: [{ id: Number(values[0]) + 1_000, task_id: Number(values[0]), content: values[2] }] };
      }
      if (source.startsWith("UPDATE tasks SET state = 'COPY_REVIEW_PENDING'")) return { rows: [] };
      if (source.startsWith('UPDATE copy_sampling_items SET status = $2')) {
        state.itemUpdates.push({ id: Number(values[0]), status: values[1] });
        return { rows: [] };
      }
      if (source.startsWith("UPDATE copy_sampling_freezes SET status = 'BATCH_RETURNED'")) return { rows: [] };
      if (source.startsWith("UPDATE production_batches SET status = 'BATCH_RETURNED'")) return { rows: [] };
      if (source.startsWith('INSERT INTO copy_sampling_events')) {
        state.eventDetails = values[7];
        return { rows: [] };
      }
      if (source.startsWith('INSERT INTO copy_sampling_mutation_requests')) return { rows: [] };
      throw new Error(`unexpected SQL: ${source}`);
    },
  };
  return { state, pool: { query: client.query.bind(client), connect: async () => client } };
}

test('a random item already returned singly can trigger an atomic return of the remaining held batch', async () => {
  const fixture = singleToBatchFixture();
  const actor = { userId: 91, username: 'qa-reviewer', role: 'REVIEWER' };
  const preview = await getCopyQaBatchReturnPreview(fixture.pool, FREEZE_ID, actor);
  assert.equal(preview.confirmedCount, 3);
  assert.deepEqual(preview.items.map((item) => item.id), [TRIGGER_ID, PENDING_ID, HELD_ID]);
  assert.ok(preview.triggerCandidates.includes(TRIGGER_ID));

  const result = await batchReturnCopyQa(fixture.pool, {
    freezePublicId: FREEZE_ID,
    triggerSamplingItemId: TRIGGER_ID,
    itemIds: preview.items.map((item) => item.id),
    confirmedCount: preview.confirmedCount,
    reasonCodes: ['FACT_ERROR'],
    note: '单条已确认错误，现升级为整批返工',
    requestId: '55555555-5555-4555-8555-555555555555',
  }, actor);

  assert.deepEqual(fixture.state.returnedRevisionTaskIds, [992, 993],
    'the already-returned trigger must not receive a duplicate placeholder revision');
  assert.deepEqual(fixture.state.itemUpdates, [
    { id: 72, status: 'BATCH_AFFECTED' },
    { id: 73, status: 'BATCH_AFFECTED' },
  ]);
  assert.deepEqual(fixture.state.eventDetails.alreadyReturnedItemIds, [TRIGGER_ID]);
  assert.deepEqual(fixture.state.eventDetails.affectedItemIds, [PENDING_ID, HELD_ID]);
  assert.deepEqual(result, {
    freezePublicId: FREEZE_ID,
    status: 'BATCH_RETURNED',
    triggerSamplingItemId: TRIGGER_ID,
    affectedCount: 2,
  });
});
