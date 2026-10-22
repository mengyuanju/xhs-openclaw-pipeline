import assert from 'node:assert/strict';
import test from 'node:test';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';

function fixture(overrides = {}, actorOverrides = {}) {
  const actor = { userId: 2, username: 'alice', role: 'USER', credentialVersion: 1, ...actorOverrides };
  const task = { id: 51, query: '测试', input: {}, state: 'IMAGE_FAILED',
    current_stage: 'FAILED', assigned_to_user_id: 'alice', current_copy_revision_id: 12,
    current_image_run_id: '55555555-5555-4555-8555-555555555555', current_execution_id: null,
    created_at: new Date(), updated_at: new Date(), ...overrides };
  const calls = [];
  const client = { release() {}, async query(sql, values) {
    calls.push({ sql, values });
    if (sql.includes('SELECT * FROM app_users')) return { rows: [actor] };
    if (sql.includes('SELECT * FROM tasks')) return { rows: [{ ...task }] };
    if (sql.includes('UPDATE tasks SET')) {
      Object.assign(task, { state: 'COPY_REVIEW_PENDING', current_stage: 'IMAGE_RETRY_EXHAUSTED',
        mandatory_copy_qc: true, mandatory_copy_qc_origin: 'IMAGE_RETRY_REVIEW', pending_snapshot: null, error: null });
      return { rows: [{ ...task }] };
    }
    return { rows: [] };
  } };
  const repository = new PostgresControlPlaneRepository({ pool: { connect: async () => client } });
  return { actor, task, calls, repository };
}

test('owner returns failed images to editable mandatory copy recheck and keeps versions', async () => {
  const f = fixture();
  const result = await f.repository.returnFailedImagesToCopyReview(51, { actor: f.actor });
  assert.equal(result.state, 'COPY_REVIEW_PENDING');
  assert.equal(result.currentStage, 'IMAGE_RETRY_EXHAUSTED');
  assert.equal(result.currentCopyRevisionId, 12);
  assert.equal(result.currentImageRunId, f.task.current_image_run_id);
  assert.equal(f.task.mandatory_copy_qc, true);
  const update = f.calls.find(c => c.sql.includes('UPDATE tasks SET'));
  assert.match(update.sql, /pending_snapshot = NULL/);
  assert.match(update.sql, /mandatory_copy_qc_origin = 'IMAGE_RETRY_REVIEW'/);
  assert.equal(f.calls.at(-1).sql, 'COMMIT');
  await assert.rejects(f.repository.returnFailedImagesToCopyReview(51, { actor: f.actor }), { code: 'IMAGE_COPY_RETURN_UNAVAILABLE' });
});

test('administrator may return another owner task', async () => {
  const f = fixture({ assigned_to_user_id: 'bob' }, { role: 'ADMIN' });
  assert.equal((await f.repository.returnFailedImagesToCopyReview(51, { actor: f.actor })).state, 'COPY_REVIEW_PENDING');
});

for (const overrides of [{ state: 'IMAGE_RUNNING' }, { state: 'MANUAL_ARCHIVE' },
  { state: 'COPY_REVIEW_PENDING' }, { current_execution_id: 'running' }, { current_copy_revision_id: null }]) {
  test(`rejects stale or ineligible task ${JSON.stringify(overrides)}`, async () => {
    const f = fixture(overrides);
    await assert.rejects(f.repository.returnFailedImagesToCopyReview(51, { actor: f.actor }), { code: 'IMAGE_COPY_RETURN_UNAVAILABLE' });
    assert.equal(f.calls.some(c => c.sql.includes('UPDATE tasks SET')), false);
    assert.equal(f.calls.at(-1).sql, 'ROLLBACK');
  });
}

for (const [overrides, actorOverrides] of [[{ assigned_to_user_id: 'bob' }, {}], [{}, { role: 'REVIEWER' }]]) {
  test(`rejects unauthorized actor ${JSON.stringify([overrides, actorOverrides])}`, async () => {
    const f = fixture(overrides, actorOverrides);
    await assert.rejects(f.repository.returnFailedImagesToCopyReview(51, { actor: f.actor }));
    assert.equal(f.calls.some(c => c.sql.includes('UPDATE tasks SET')), false);
  });
}
