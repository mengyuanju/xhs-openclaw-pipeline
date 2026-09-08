import assert from 'node:assert/strict';
import test from 'node:test';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { createControlPlaneApp } from '../src/http-server.mjs';

const runId = '44444444-4444-4444-8444-444444444444';
const otherRunId = '55555555-5555-4555-8555-555555555555';
const reviewSessionId = '66666666-6666-4666-8666-666666666666';

function fixture(overrides = {}, { completedRun = true } = {}) {
  const task = { id: 7, state: 'MANUAL_ARCHIVE', current_image_run_id: runId,
    current_copy_revision_id: 3, created_by_user_id: 'alice', current_execution_id: null,
    requested_image_count: '3', progress_percent: 100, finished_at: '2026-09-06T00:00:00Z', ...overrides };
  const queries = [];
  const assessments = [];
  const submissions = [];
  const client = {
    release() {},
    async query(sql, values = []) {
      queries.push({ sql, values });
      if (/^(BEGIN|COMMIT|ROLLBACK)$/u.test(sql)) return { rows: [] };
      if (sql.includes('SELECT * FROM tasks')) return { rows: [{ ...task }] };
      if (sql.includes('INSERT INTO human_quality_review_submissions')) {
        if (submissions.some((row) => row.review_session_id === values[0])) return { rows: [] };
        const row = { review_session_id: values[0], task_id: values[1], stage: values[2],
          reviewer_username: values[3], request_fingerprint: values[4] };
        submissions.push(row);
        return { rows: [row] };
      }
      if (sql.includes('FROM human_quality_review_submissions')) {
        return { rows: submissions.filter((row) => row.review_session_id === values[0]) };
      }
      if (sql.includes('SELECT id FROM image_runs')) return { rows: completedRun ? [{ id: runId }] : [] };
      if (sql.includes('SELECT id FROM assets')) {
        return { rows: values[2].filter((id) => [101, 102].includes(id)).map((id) => ({ id })) };
      }
      if (sql.includes('INSERT INTO human_quality_assessments')) {
        const row = {
          id: assessments.length + 1,
          task_id: values[0], stage: values[1], copy_revision_id: values[2], image_run_id: values[3],
          score_x10: values[4], rating_context: values[5], action: values[6], reason_codes: values[7],
          problem_asset_ids: values[8], note: values[9], reviewer_username: values[10],
          review_session_id: values[11], request_fingerprint: values[12], created_at: new Date(),
        };
        assessments.push(row);
        return { rows: [row] };
      }
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
  return { task, queries, assessments, repository: new PostgresControlPlaneRepository({ pool: { connect: async () => client } }) };
}

for (const [decision, expected] of [['APPROVE', 'REVIEWED'], ['RETRY', 'IMAGE_QUEUED'], ['DISCARD', 'CANCELLED']]) {
  test(`image review ${decision} leaves manual archive as ${expected}`, async () => {
    const { repository, task, queries, assessments } = fixture();
    const input = { imageRunId: runId, decision, score: decision === 'APPROVE' ? 2.5 : 2,
      note: '记录本轮图片问题', reviewerUserId: 'reviewer', reviewSessionId };
    const result = await repository.reviewImages(7, input);
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
    assert.equal(assessments.length, 1);
    assert.equal(assessments[0].score_x10, decision === 'APPROVE' ? 25 : 20);
    assert.equal((await repository.reviewImages(7, input)).state, expected, 'same session is idempotent');
    assert.equal(assessments.length, 1);
  });
}

test('stale image review cannot approve, retry or discard a newer image run', async () => {
  for (const decision of ['APPROVE', 'RETRY', 'DISCARD']) {
    const { repository, queries } = fixture({ current_image_run_id: otherRunId });
    await assert.rejects(repository.reviewImages(7, { imageRunId: runId, decision, score: 2.5,
      note: '轻微问题', reviewerUserId: 'reviewer', reviewSessionId }), { code: 'STALE_IMAGE_RUN' });
    assert.ok(queries.every(({ sql }) => !sql.includes('UPDATE tasks')));
    assert.equal(queries.at(-1).sql, 'ROLLBACK');
  }
});

test('invalid review input is rejected before mutation', async () => {
  for (const input of [{ decision: 'unknown' }, { imageRunId: 'bad' }, { reviewerUserId: '' },
    { score: 2.25 }, { reviewSessionId: 'bad' }]) {
    const { repository, queries } = fixture();
    await assert.rejects(repository.reviewImages(7, { imageRunId: runId, decision: 'APPROVE', score: 2.5,
      note: '轻微问题', reviewerUserId: 'reviewer', reviewSessionId, ...input }), TypeError);
    assert.equal(queries.length, 0);
  }
});

test('approval rejects an unfinished image run or images from an older copy revision', async () => {
  const { repository, queries } = fixture({}, { completedRun: false });
  await assert.rejects(repository.reviewImages(7, { imageRunId: runId, decision: 'APPROVE', score: 2.5,
    note: '轻微问题', reviewerUserId: 'reviewer', reviewSessionId }), { code: 'STALE_IMAGE_RUN' });
  assert.ok(queries.every(({ sql }) => !sql.includes('UPDATE tasks')));
});

test('image review validates and stores low-score feedback and current-run problem assets', async () => {
  const { repository, assessments } = fixture();
  await repository.reviewImages(7, {
    imageRunId: runId,
    decision: 'RETRY',
    score: 2,
    reasons: ['TEXT_ERROR'],
    problemAssetIds: [102, 101],
    reviewerUserId: 'reviewer',
    reviewSessionId,
  });
  assert.deepEqual(assessments[0].reason_codes, ['TEXT_ERROR']);
  assert.deepEqual(assessments[0].problem_asset_ids, [101, 102]);

  for (const input of [
    { decision: 'APPROVE', score: 2, reasons: ['TEXT_ERROR'] },
    { decision: 'RETRY', score: 2 },
  ]) {
    const invalid = fixture();
    await assert.rejects(invalid.repository.reviewImages(7, {
      imageRunId: runId, reviewerUserId: 'reviewer', reviewSessionId, ...input,
    }), input.decision === 'APPROVE' ? { code: 'QUALITY_SCORE_TOO_LOW' } : TypeError);
    assert.equal(invalid.assessments.length, 0);
  }

  const staleAsset = fixture();
  await assert.rejects(staleAsset.repository.reviewImages(7, {
    imageRunId: runId,
    decision: 'DISCARD',
    score: 1,
    reasons: ['CONTENT_MISMATCH'],
    problemAssetIds: [999],
    reviewerUserId: 'reviewer',
    reviewSessionId,
  }), { code: 'INVALID_PROBLEM_ASSETS' });
  assert.equal(staleAsset.assessments.length, 0);
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
        body: JSON.stringify({ imageRunId: runId, decision: 'APPROVE', score: 2.5,
          note: '轻微问题', reviewSessionId, reviewerUserId: 'spoofed' }),
      });
      assert.equal(response.status, status);
    }
    assert.deepEqual(calls.map(([, input]) => input.reviewerUserId), ['reviewer', 'admin']);
    assert.deepEqual(calls[0][1], {
      imageRunId: runId,
      decision: 'APPROVE',
      score: 2.5,
      reasons: undefined,
      note: '轻微问题',
      problemAssetIds: undefined,
      reviewSessionId,
      reviewerUserId: 'reviewer',
    });
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
