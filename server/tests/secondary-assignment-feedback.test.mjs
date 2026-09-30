import test from 'node:test';
import assert from 'node:assert/strict';
import { readSecondaryAssignmentFeedback, secondaryAssignmentFeedbackFrom } from '../src/secondary-assignment-feedback.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';

test('secondary assignment feedback contains only readable verdict fields and immutable labels', () => {
  const result = secondaryAssignmentFeedbackFrom({
    assigned_at: '2026-09-30T01:00:00Z', operator_username: 'SECRET-OPERATOR',
    entries: [{ stage: 'COPY', reasonCodes: ['CUSTOM:SECRET-UUID', 'FACT_ERROR', 'FACT_ERROR'],
      reasonSnapshots: [{ code: 'CUSTOM:SECRET-UUID', group: 'PLAN', label: '封面关键信息有误' }],
      note: '  请核对第 4 页的说明。\n文字保留换行。  ', reviewedAt: '2026-09-29T04:00:00Z',
      reviewerUsername: 'SECRET-REVIEWER', sourceItemId: 132, content: 'SECRET-OLD-CONTENT' },
    { stage: 'COPY', reasonCodes: ['CUSTOM:MISSING-SNAPSHOT'], note: '历史标签已停用', reviewedAt: 'bad date' }],
  });
  assert.deepEqual(result, { assignedAt: '2026-09-30T01:00:00.000Z', entries: [
    { stage: 'COPY', reasonLabels: ['图文规划 · 封面关键信息有误', '正文 · 事实或数据错误'],
      note: '请核对第 4 页的说明。\n文字保留换行。', reviewedAt: '2026-09-29T04:00:00.000Z' },
    { stage: 'COPY', reasonLabels: ['历史自定义问题标签'], note: '历史标签已停用', reviewedAt: null },
  ] });
  const json = JSON.stringify(result);
  for (const secret of ['SECRET-OPERATOR', 'SECRET-REVIEWER', 'SECRET-UUID', '132', 'SECRET-OLD-CONTENT']) {
    assert.equal(json.includes(secret), false, secret);
  }
});

test('feedback tolerates absent data, old snapshot-only labels and image verdicts', () => {
  for (const row of [null, {}, { entries: null }, { entries: [null, {}, { stage: 'COPY', note: ' ' }] }]) {
    assert.equal(secondaryAssignmentFeedbackFrom(row), null);
  }
  assert.deepEqual(secondaryAssignmentFeedbackFrom({ assigned_at: 'bad date', entries: [
    { stage: 'COPY', reasonSnapshots: [{ group: 'BODY', label: '仅保留的历史反馈' }] },
    { stage: 'IMAGE', reasonCodes: ['TEXT_ERROR'], note: '第 2 页错字' },
  ] }), { assignedAt: null, entries: [
    { stage: 'COPY', reasonLabels: ['正文 · 仅保留的历史反馈'], note: null, reviewedAt: null },
    { stage: 'IMAGE', reasonLabels: ['画面文字错误'], note: '第 2 页错字', reviewedAt: null },
  ] });
});

test('feedback read uses task parameters and anchors the current assignment and prior quality cycle', async () => {
  let query;
  const pool = { async query(sql, values) { query = { sql, values }; return { rows: [] }; } };
  assert.equal(await readSecondaryAssignmentFeedback(pool, 108), null);
  assert.deepEqual(query.values, [108]);
  assert.match(query.sql, /assignment\.ended_at IS NULL/u);
  assert.match(query.sql, /assignment\.source='SECOND_ASSIGNMENT'/u);
  assert.match(query.sql, /reassignment\.assignment_record_id=assignment\.previous_record_id/u);
  assert.match(query.sql, /reassignment\.target_account_id=assignment\.assignee_account_id/u);
  assert.match(query.sql, /reassignment\.created_at <= assignment\.assigned_at/u);
  assert.match(query.sql, /event\.quality_cycle=current_case\.previous_quality_cycle/u);
  assert.match(query.sql, /event\.created_at <= current_case\.created_at/u);
  assert.match(query.sql, /verdict\.details->'affectedItemIds' \? legacy\.public_id::text/u);
  await assert.rejects(readSecondaryAssignmentFeedback(pool, '108; DELETE FROM tasks'), /taskId/u);
});

test('task detail adds feedback without changing current content or return flags', async () => {
  let assignedAt = '2026-09-30T01:00:00Z';
  const repository = new PostgresControlPlaneRepository({ pool: { async query(sql) {
    if (sql.includes('WITH active_assignment AS')) return { rows: [{ assigned_at: '2026-09-30T01:00:00Z',
      entries: [{ stage: 'COPY', reasonCodes: ['FACT_ERROR'], note: '前次反馈', reviewedAt: '2026-09-29T01:00:00Z' }] }] };
    if (sql.includes('WITH task AS')) return { rows: [{ id: '108', input: {}, state: 'COPY_REVIEW_PENDING',
      current_copy_revision_id: '55', assigned_at: assignedAt,
      mandatory_copy_qc: true, mandatory_copy_qc_origin: 'SECOND_ASSIGNMENT',
      copy_qa_rework_pending: false }] };
    if (sql.includes('SELECT * FROM copy_revisions')) return { rows: [{ id: '55', task_id: '108', revision: 3,
      content: { copy: { title: '机器初稿' } }, revision_origin: 'SECOND_ASSIGNMENT_RESET' }] };
    return { rows: [] };
  } } });
  const detail = await repository.getTask(108);
  assert.equal(detail.secondaryAssignmentFeedback.entries[0].note, '前次反馈');
  assert.equal(detail.currentCopyRevisionId, 55);
  assert.equal(detail.copyRevisions[0].content.copy.title, '机器初稿');
  assert.equal(detail.copyQaReworkPending, false);
  assert.equal(detail.copyRevisions[0].reworkOrigin, null);
  assert.equal(detail.mandatoryCopyQcOrigin, 'SECOND_ASSIGNMENT');
  assignedAt = '2026-09-30T02:00:00Z';
  assert.equal((await repository.getTask(108)).secondaryAssignmentFeedback, null,
    'a concurrent assignment change cannot attach feedback from a different detail snapshot');
});
