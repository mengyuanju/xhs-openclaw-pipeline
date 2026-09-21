import assert from 'node:assert/strict';
import test from 'node:test';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';

const admin = { userId: 1, username: 'admin', role: 'ADMIN', credentialVersion: 1 };
const updatedAt = '2026-09-20T00:00:00.000Z';

function fixture({ from = 'COPY_REVIEW_PENDING', revision = 12, versions = {}, state = 'CANCELLED', account = true } = {}) {
  const calls = [];
  const task = { id: 51, query: '恢复测试', input: {}, state, cancelled_from_state: from,
    current_copy_revision_id: revision, current_image_run_id: null, updated_at: updatedAt,
    created_at: updatedAt, requested_image_count: 'auto' };
  const client = { release() {}, async query(sql, values = []) {
    calls.push({ sql, values });
    if (sql.includes('SELECT * FROM app_users')) return { rows: account ? [{ ...admin }] : [] };
    if (sql.includes('SELECT * FROM tasks WHERE id')) return { rows: [{ ...task }] };
    if (sql.includes('AS copy_released')) return { rows: [versions] };
    if (sql.includes('INSERT INTO copy_revisions')) return { rows: [{ id: 13 }] };
    if (sql.includes('UPDATE tasks SET state = $2')) {
      Object.assign(task, { state: values[1], current_copy_revision_id: values[2], cancelled_from_state: null });
      return { rows: [{ ...task }] };
    }
    return { rows: [] };
  } };
  return { calls, repository: new PostgresControlPlaneRepository({ pool: { connect: async () => client } }) };
}

for (const [from, revision, versions, expected] of [
  ['COPY_QUEUED', null, {}, 'COPY_QUEUED'],
  ['COPY_RUNNING', null, {}, 'COPY_QUEUED'],
  ['COPY_FAILED', null, {}, 'COPY_QUEUED'],
  ['COPY_REVIEW_PENDING', 12, {}, 'COPY_REVIEW_PENDING'],
  ['COPY_QC_PENDING', 12, {}, 'COPY_REVIEW_PENDING'],
  ['IMAGE_QUEUED', 12, { copy_released: true }, 'IMAGE_QUEUED'],
  ['IMAGE_RUNNING', 12, { copy_released: true }, 'IMAGE_QUEUED'],
  ['IMAGE_FAILED', 12, { copy_released: true }, 'IMAGE_QUEUED'],
  ['MANUAL_ARCHIVE', 12, { copy_released: true, image_completed: true }, 'MANUAL_ARCHIVE'],
  ['IMAGE_REWORK_PENDING', 12, { copy_released: true, image_completed: true }, 'IMAGE_REWORK_PENDING'],
  ['IMAGE_QC_PENDING', 12, { copy_released: true, image_completed: true, image_submitted: true }, 'IMAGE_REWORK_PENDING'],
  ['REVIEWED', 12, { copy_released: true, image_completed: true, image_submitted: true }, 'IMAGE_REWORK_PENDING'],
  ['IMAGE_QUEUED', 12, { copy_released: false }, 'COPY_REVIEW_PENDING'],
  [null, null, {}, 'COPY_QUEUED'],
  [null, 12, {}, 'COPY_REVIEW_PENDING'],
]) {
  test(`restores ${from ?? 'legacy discard'} to ${expected} with revision ${revision}`, async () => {
    const f = fixture({ from, revision, versions });
    const result = await f.repository.restoreCancelledTask(51, { expectedUpdatedAt: updatedAt }, { actor: admin });
    assert.equal(result.state, expected);
    assert.equal(result.cancelledFromState, null);
    assert.equal(f.calls.filter(c => c.sql.includes('INSERT INTO task_restore_events')).length, 1);
    assert.equal(f.calls.some(c => c.sql.includes('INSERT INTO copy_revisions')), expected === 'COPY_REVIEW_PENDING');
    assert.ok(f.calls.some(c => c.sql.includes('image_qc_released_approval_event_id = NULL')));
    assert.equal(f.calls.at(-1).sql, 'COMMIT');
    await assert.rejects(f.repository.restoreCancelledTask(51, { expectedUpdatedAt: updatedAt }, { actor: admin }), { code: 'RESTORE_UNAVAILABLE' });
    assert.equal(f.calls.filter(c => c.sql.includes('INSERT INTO task_restore_events')).length, 1);
  });
}

test('restore rejects non-admins, revoked identities and stale discard snapshots before any writes', async () => {
  for (const [options, actor, input, error] of [
    [{}, { ...admin, role: 'USER' }, { expectedUpdatedAt: updatedAt }, { code: 'FORBIDDEN' }],
    [{}, { ...admin, role: 'REVIEWER' }, { expectedUpdatedAt: updatedAt }, { code: 'FORBIDDEN' }],
    [{ account: false }, admin, { expectedUpdatedAt: updatedAt }, { code: 'SESSION_STALE' }],
    [{}, admin, { expectedUpdatedAt: '2026-09-19T00:00:00Z' }, { code: 'TASK_CHANGED' }],
    [{}, admin, {}, TypeError],
  ]) {
    const f = fixture(options);
    await assert.rejects(f.repository.restoreCancelledTask(51, input, { actor }), error);
    assert.equal(f.calls.some(c => /(?:UPDATE|INSERT INTO)\s+(?:tasks|copy_revisions|task_restore_events)/u.test(c.sql)), false);
    assert.equal(f.calls.at(-1).sql, 'ROLLBACK');
  }
});
