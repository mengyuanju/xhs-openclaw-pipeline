import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { submitImageSelfReview } from '../src/image-quality-control.mjs';

const imageRunId = '11111111-1111-4111-8111-111111111111';
const reviewSessionId = '22222222-2222-4222-8222-222222222222';
const actor = { userId: 7, username: 'worker', role: 'USER', credentialVersion: 1 };
const submission = { imageRunId, reviewSessionId };
const imageSetSha256 = createHash('sha256').update(JSON.stringify([
  { id: 61, mediaType: 'image/png', byteSize: 100, sha256: 'a'.repeat(64),
    originalName: '01.png', pageIndex: 1 },
])).digest('hex');

function replayPool({ note = null, task = {}, pendingEdits = 0, approval = {} } = {}) {
  const queries = [];
  const client = {
    async query(sql, values = []) {
      const source = String(sql).replace(/\s+/gu, ' ').trim();
      queries.push({ sql: source, values });
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(source)) return { rows: [] };
      if (source.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] };
      if (source.startsWith('SELECT id, username, role, created_at FROM app_users')) {
        return { rows: [{ id: actor.userId, username: actor.username, role: actor.role }] };
      }
      if (source === 'SELECT * FROM tasks WHERE id = $1 FOR UPDATE') {
        return { rows: [{ id: 41, assigned_to_user_id: actor.username,
          state: 'IMAGE_QC_PENDING', current_image_run_id: imageRunId,
          current_copy_revision_id: 51, ...task }] };
      }
      if (source.startsWith('SELECT id FROM image_runs')) {
        return { rows: values[0] === imageRunId && values[1] === 41 && values[2] === 51
          ? [{ id: imageRunId }] : [] };
      }
      if (source.includes('FROM image_edit_requests')) return { rows: [{ count: pendingEdits }] };
      if (source.startsWith('SELECT asset.id, asset.media_type')) {
        return { rows: [{ id: 61, media_type: 'image/png', byte_size: 100,
          sha256: 'a'.repeat(64), original_name: '01.png', page_index: 1, expected_page_count: 1 }] };
      }
      if (source.startsWith('SELECT * FROM image_approval_events')) {
        const existing = { id: 71, task_id: 41, copy_revision_id: 51, image_run_id: imageRunId,
          submitted_by_account_id: actor.userId, submitted_by_username: actor.username,
          review_session_id: reviewSessionId, image_set_sha256: imageSetSha256,
          manual_modification_note: note, ...approval };
        return { rows: values[0] === existing.submitted_by_username && values[1] === existing.review_session_id
          ? [existing] : [] };
      }
      if (source.startsWith('SELECT id FROM image_approval_events')) return { rows: [{ id: 71 }] };
      if (source.startsWith('SELECT id, media_type, byte_size, sha256, original_name')) return { rows: [] };
      assert.fail(`Unexpected replay query: ${source}`);
    },
    release() {},
  };
  return { pool: { connect: async () => client }, queries };
}

test('manual modification notes reject invalid input before opening a transaction', async () => {
  const pool = { connect() { assert.fail('invalid note reached the database'); } };
  for (const manualModificationNote of [1, false, {}, [], '文'.repeat(1001), '😀'.repeat(1001)]) {
    await assert.rejects(submitImageSelfReview(pool, 41, { ...submission, manualModificationNote }, actor),
      typeof manualModificationNote === 'string' ? RangeError : TypeError);
  }
});

test('a successful image self-review can replay its frozen normalized note', async () => {
  for (const state of ['IMAGE_REWORK_PENDING', 'IMAGE_QC_PENDING', 'REVIEWED']) {
    const fixture = replayPool({ note: '第 1 张，右上角标题\n修改字号', task: { state } });
    const result = await submitImageSelfReview(fixture.pool, 41, {
      ...submission, manualModificationNote: '  第 1 张，右上角标题\r\n修改字号  ',
    }, actor);
    assert.deepEqual(result, { taskId: 41, state, approvalEventId: 71, idempotent: true });
    assert.equal(fixture.queries.some(({ sql }) => /^(INSERT|UPDATE|DELETE)/u.test(sql)), false);
  }
});

test('empty and legacy missing image approval notes remain compatible on replay', async () => {
  for (const manualModificationNote of [undefined, null, '', ' \r\n ']) {
    const fixture = replayPool();
    assert.equal((await submitImageSelfReview(fixture.pool, 41,
      { ...submission, manualModificationNote }, actor)).idempotent, true);
  }
  const fixture = replayPool({ note: '😀'.repeat(1000) });
  assert.equal((await submitImageSelfReview(fixture.pool, 41,
    { ...submission, manualModificationNote: '😀'.repeat(1000) }, actor)).idempotent, true);
});

test('reusing the same image self-review session cannot change or clear its note', async () => {
  for (const manualModificationNote of ['另一个修改点位', '', null, undefined]) {
    const fixture = replayPool({ note: '第 1 张右下角文字需要调整' });
    await assert.rejects(submitImageSelfReview(fixture.pool, 41,
      { ...submission, manualModificationNote }, actor), { code: 'REQUEST_ID_CONFLICT' });
    assert.equal(fixture.queries.some(({ sql }) => /^(INSERT|UPDATE|DELETE)/u.test(sql)), false);
  }
  const fixture = replayPool({ note: '已冻结' });
  await assert.rejects(submitImageSelfReview(fixture.pool, 41, {
    ...submission, reviewSessionId: '33333333-3333-4333-8333-333333333333',
    manualModificationNote: '已冻结',
  }, actor), { code: 'IMAGE_ALREADY_SUBMITTED' });
});

test('image self-review sessions cannot be reused for another task, version, account or frozen image set', async () => {
  for (const approval of [
    { task_id: 42 }, { copy_revision_id: 52 },
    { image_run_id: '33333333-3333-4333-8333-333333333333' },
    { submitted_by_account_id: 8 }, { image_set_sha256: 'b'.repeat(64) },
  ]) {
    const fixture = replayPool({ approval });
    await assert.rejects(submitImageSelfReview(fixture.pool, 41, submission, actor), { code: 'REQUEST_ID_CONFLICT' });
    assert.equal(fixture.queries.some(({ sql }) => /^(INSERT|UPDATE|DELETE)/u.test(sql)), false);
  }
});

test('an already submitted ordinary image cannot create another approval in the initial-review state', async () => {
  const fixture = replayPool({ task: { state: 'MANUAL_ARCHIVE' } });
  await assert.rejects(submitImageSelfReview(fixture.pool, 41, {
    ...submission, reviewSessionId: '33333333-3333-4333-8333-333333333333',
  }, actor), { code: 'IMAGE_ALREADY_SUBMITTED' });
  assert.equal(fixture.queries.some(({ sql }) => /^(INSERT|UPDATE|DELETE)/u.test(sql)), false);
});

test('image approval note replays keep ownership, pause, version and pending-edit checks', async () => {
  for (const [options, code] of [
    [{ task: { assigned_to_user_id: 'someone-else' } }, 'FORBIDDEN'],
    [{ task: { priority_paused: true } }, 'TASK_PRIORITY_PAUSED'],
    [{ task: { state: 'CANCELLED' } }, 'INVALID_TASK_STATE'],
    [{ task: { current_image_run_id: '33333333-3333-4333-8333-333333333333' } }, 'STALE_IMAGE_RUN'],
    [{ task: { current_copy_revision_id: 52 } }, 'STALE_IMAGE_RUN'],
    [{ pendingEdits: 1 }, 'IMAGE_EDITS_PENDING'],
  ]) {
    const fixture = replayPool({ ...options, note: '之后手动修改' });
    await assert.rejects(submitImageSelfReview(fixture.pool, 41,
      { ...submission, manualModificationNote: '之后手动修改' }, actor), { code });
    assert.equal(fixture.queries.some(({ sql }) => /^(INSERT|UPDATE|DELETE)/u.test(sql)), false);
  }
});
