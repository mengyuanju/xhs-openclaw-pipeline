import assert from 'node:assert/strict';
import test from 'node:test';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { createControlPlaneApp } from '../src/http-server.mjs';

const runId = '44444444-4444-4444-8444-444444444444';
const otherRunId = '55555555-5555-4555-8555-555555555555';

function fixture(overrides = {}, { completedRun = true } = {}) {
  const task = { id: 7, state: 'MANUAL_ARCHIVE', current_image_run_id: runId,
    current_copy_revision_id: 3, created_by_user_id: 'alice', current_execution_id: null,
    requested_image_count: '3', progress_percent: 100, finished_at: '2026-09-06T00:00:00Z', ...overrides };
  const queries = [];
  const client = {
    release() {},
    async query(sql, values = []) {
      queries.push({ sql, values });
      if (/^(BEGIN|COMMIT|ROLLBACK)$/u.test(sql)) return { rows: [] };
      if (sql.includes('SELECT * FROM tasks')) return { rows: [{ ...task }] };
      if (sql.includes('SELECT id FROM image_runs')) return { rows: completedRun ? [{ id: runId }] : [] };
      if (sql.includes('UPDATE tasks SET')) {
        const retry = values[1] === 'IMAGE_QUEUED';
        Object.assign(task, { state: values[1], current_stage: values[1], progress_message: values[2],
          current_image_run_id: retry ? null : runId, pending_snapshot: null,
          image_reviewed_by_user_id: values[1] === 'REVIEWED' ? values[3] : null,
          image_reviewed_at: values[1] === 'REVIEWED' ? '2026-09-06T01:00:00Z' : null });
        return { rows: [{ ...task }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  return { task, queries, repository: new PostgresControlPlaneRepository({ pool: { connect: async () => client } }) };
}

for (const [decision, expected] of [['APPROVE', 'REVIEWED'], ['RETRY', 'IMAGE_QUEUED'], ['DISCARD', 'CANCELLED']]) {
  test(`image review ${decision} leaves manual archive as ${expected}`, async () => {
    const { repository, task, queries } = fixture();
    const result = await repository.reviewImages(7, { imageRunId: runId, decision, reviewerUserId: 'reviewer' });
    assert.equal(result.state, expected);
    assert.equal(result.currentCopyRevisionId, 3);
    assert.equal(result.createdByUserId, 'alice');
    assert.equal(result.currentImageRunId, decision === 'RETRY' ? null : runId);
    assert.equal(result.imageReviewedByUserId, decision === 'APPROVE' ? 'reviewer' : null);
    assert.equal(Boolean(result.imageReviewedAt), decision === 'APPROVE');
    if (decision === 'RETRY') assert.equal(task.pending_snapshot, null);
    assert.ok(queries.some(({ sql }) => sql.includes('FOR UPDATE')));
    assert.equal(queries.at(-1).sql, 'COMMIT');
    assert.ok(queries.every(({ sql }) => !/DELETE|UPDATE image_runs|UPDATE copy_revisions/u.test(sql)));
    await assert.rejects(repository.reviewImages(7, { imageRunId: runId, decision, reviewerUserId: 'reviewer' }), { code: 'INVALID_TASK_STATE' });
  });
}

test('stale image review cannot approve, retry or discard a newer image run', async () => {
  for (const decision of ['APPROVE', 'RETRY', 'DISCARD']) {
    const { repository, queries } = fixture({ current_image_run_id: otherRunId });
    await assert.rejects(repository.reviewImages(7, { imageRunId: runId, decision, reviewerUserId: 'reviewer' }), { code: 'STALE_IMAGE_RUN' });
    assert.ok(queries.every(({ sql }) => !sql.includes('UPDATE tasks')));
    assert.equal(queries.at(-1).sql, 'ROLLBACK');
  }
});

test('invalid review input is rejected before mutation', async () => {
  for (const input of [{ decision: 'unknown' }, { imageRunId: 'bad' }, { reviewerUserId: '' }]) {
    const { repository, queries } = fixture();
    await assert.rejects(repository.reviewImages(7, { imageRunId: runId, decision: 'APPROVE', reviewerUserId: 'reviewer', ...input }), TypeError);
    assert.equal(queries.length, 0);
  }
});

test('approval rejects an unfinished image run or images from an older copy revision', async () => {
  const { repository, queries } = fixture({}, { completedRun: false });
  await assert.rejects(repository.reviewImages(7, { imageRunId: runId, decision: 'APPROVE', reviewerUserId: 'reviewer' }), { code: 'STALE_IMAGE_RUN' });
  assert.ok(queries.every(({ sql }) => !sql.includes('UPDATE tasks')));
});

test('image review allows reviewers across owners, rejects ordinary users and derives reviewer identity from session', async () => {
  const calls = [];
  const repository = {
    getUserByUsername: async (username) => ({ username, role: username === 'alice' ? 'USER' : username === 'admin' ? 'ADMIN' : 'REVIEWER', status: 'ACTIVE', credentialVersion: 1 }),
    getTask: async () => ({ id: 7, state: 'MANUAL_ARCHIVE', createdByUserId: 'alice' }),
    reviewImages: async (...args) => { calls.push(args); return { state: 'REVIEWED' }; },
  };
  const server = createControlPlaneApp({ repository, storageRoot: 'test-storage' }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    for (const [username, role, status] of [['reviewer', 'REVIEWER', 200], ['admin', 'ADMIN', 200], ['alice', 'USER', 403]]) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/tasks/7/review-images`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Actor-Username': username, 'X-Actor-Role': role, 'X-Actor-Credential-Version': '1' },
        body: JSON.stringify({ imageRunId: runId, decision: 'APPROVE', reviewerUserId: 'spoofed' }),
      });
      assert.equal(response.status, status);
    }
    assert.deepEqual(calls.map(([, input]) => input.reviewerUserId), ['reviewer', 'admin']);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
