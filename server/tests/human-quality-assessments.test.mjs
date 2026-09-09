import assert from 'node:assert/strict';
import test from 'node:test';

import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';

const sourceExecutionId = '11111111-1111-4111-8111-111111111111';
const reviewSessionId = '77777777-7777-4777-8777-777777777777';

const validEdits = {
  copy: {
    title: '整理桌面的实用方法',
    body: '先清理不再使用的物品，再按照使用频率划分区域。'.repeat(20),
    tags: ['#桌面整理', '#收纳方法', '#效率提升'],
  },
  imagePlan: [
    { kind: 'hero', headline: '桌面整理', subtitle: '从混乱到清爽', bullets: ['清空桌面', '重新分区'], prompt: '明亮自然光下整洁桌面的前后对比画面' },
    { kind: 'steps', headline: '先做减法', subtitle: '只留下常用物品', bullets: ['判断使用频率', '移走低频物品'], prompt: '展示物品分类和筛选过程的真实桌面场景' },
    { kind: 'summary', headline: '固定位置', subtitle: '保持桌面长期整洁', bullets: ['每天复位', '每周检查'], prompt: '整洁桌面与标签明确的收纳区域近景画面' },
  ],
};

function copyFixture({ assignedToUserId = 'reviewer' } = {}) {
  const task = {
    id: 41,
    state: 'COPY_REVIEW_PENDING',
    assigned_to_user_id: assignedToUserId,
    current_copy_revision_id: 12,
    current_image_run_id: null,
    ai_disclosure_enabled: true,
    progress_percent: 100,
  };
  const queries = [];
  const assessments = [];
  const submissions = [];
  const revisions = new Map([[12, {
    id: 12, task_id: 41, revision: 1, execution_id: sourceExecutionId, content: {},
  }]]);
  let nextRevision = 13;
  const client = {
    release() {},
    async query(sql, values = []) {
      const source = String(sql);
      queries.push({ sql: source, values });
      if (/^(BEGIN|COMMIT|ROLLBACK)$/u.test(source)) return { rows: [] };
      if (source.includes('SELECT * FROM tasks WHERE id')) return { rows: [{ ...task }] };
      if (source.includes('INSERT INTO human_quality_review_submissions')) {
        if (submissions.some((row) => row.review_session_id === values[0])) return { rows: [] };
        const row = { review_session_id: values[0], task_id: values[1], stage: values[2],
          reviewer_username: values[3], request_fingerprint: values[4] };
        submissions.push(row);
        return { rows: [row] };
      }
      if (source.includes('FROM human_quality_review_submissions')) {
        return { rows: submissions.filter((row) => row.review_session_id === values[0]) };
      }
      if (source.includes('SELECT * FROM copy_revisions')) {
        const revision = revisions.get(Number(values[0]));
        return { rows: revision ? [revision] : [] };
      }
      if (source.includes('SELECT id FROM executor_nodes')) return { rows: [{ id: 'node-a' }] };
      if (source.includes('MAX(revision)')) {
        return { rows: [{ revision: Math.max(...[...revisions.values()].map((entry) => entry.revision)) + 1 }] };
      }
      if (source.includes('INSERT INTO copy_revisions')) {
        const revision = { id: nextRevision++, task_id: 41, revision: values[1], execution_id: null, content: values[2] };
        revisions.set(revision.id, revision);
        return { rows: [revision] };
      }
      if (source.includes('INSERT INTO human_quality_assessments')) {
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
      if (source.includes('UPDATE tasks SET')) {
        Object.assign(task, {
          state: source.includes("state = 'IMAGE_QUEUED'") ? 'IMAGE_QUEUED'
            : source.includes("state = 'CANCELLED'") ? 'CANCELLED' : 'COPY_REVIEW_PENDING',
          current_copy_revision_id: values[1] ?? task.current_copy_revision_id,
        });
        return { rows: [{ ...task }] };
      }
      if (source.includes('UPDATE copy_revisions')) return { rows: [] };
      throw new Error(`Unexpected SQL: ${source}`);
    },
  };
  return { task, queries, assessments, revisions,
    repository: new PostgresControlPlaneRepository({ pool: { connect: async () => client } }) };
}

test('edited copy can be saved as an unapproved revision with version-bound original and edited ratings', async () => {
  const fixture = copyFixture();
  const input = {
    revisionId: 12,
    nodeId: 'node-a',
    decision: 'SAVE',
    originalScore: 2,
    originalReasons: ['STRUCTURE'],
    edits: validEdits,
    score: 2.5,
    reasons: ['EXPRESSION'],
    reviewSessionId,
  };
  const saved = await fixture.repository.approveCopy(41, input, {
    actorRole: 'ADMIN', reviewerUserId: 'reviewer',
  });

  assert.equal(saved.state, 'COPY_REVIEW_PENDING');
  assert.equal(saved.currentCopyRevisionId, 13);
  assert.deepEqual(fixture.assessments.map(({ copy_revision_id, score_x10, rating_context, action }) => ({
    copyRevisionId: copy_revision_id, scoreX10: score_x10, ratingContext: rating_context, action,
  })), [
    { copyRevisionId: 12, scoreX10: 20, ratingContext: 'ORIGINAL', action: 'SAVE' },
    { copyRevisionId: 13, scoreX10: 25, ratingContext: 'EDITED', action: 'SAVE' },
  ]);
  const revisionInsert = fixture.queries.find(({ sql }) => sql.includes('INSERT INTO copy_revisions'));
  assert.equal(revisionInsert.values[4], 'SAVE');
  assert.match(revisionInsert.sql, /CASE WHEN \$5 = 'APPROVE' THEN now\(\) ELSE NULL END/u);
  assert.match(fixture.queries.find(({ sql }) => sql.includes('UPDATE tasks SET')).sql, /last_activity_at = now\(\).*updated_at = now\(\)/su);

  const repeated = await fixture.repository.approveCopy(41, input, {
    actorRole: 'ADMIN', reviewerUserId: 'reviewer',
  });
  assert.equal(repeated.currentCopyRevisionId, 13);
  assert.equal(fixture.assessments.length, 2, 'a network retry must not append duplicate ratings');

  await assert.rejects(fixture.repository.approveCopy(41, { ...input, note: 'different request' }, {
    actorRole: 'ADMIN', reviewerUserId: 'reviewer',
  }), { code: 'REVIEW_SESSION_CONFLICT' });
});

test('a saved edited revision can be reopened and approved using its own passing score', async () => {
  const fixture = copyFixture();
  await fixture.repository.approveCopy(41, {
    revisionId: 12, nodeId: 'node-a', decision: 'SAVE',
    originalScore: 2, originalReasons: ['STRUCTURE'],
    edits: validEdits, score: 2.5, reasons: ['EXPRESSION'], reviewSessionId,
  }, { reviewerUserId: 'reviewer' });

  const approved = await fixture.repository.approveCopy(41, {
    revisionId: 13,
    nodeId: 'node-a',
    decision: 'APPROVE',
    score: 2.5,
    reasons: ['EXPRESSION'],
    reviewSessionId: '88888888-8888-4888-8888-888888888888',
  }, { reviewerUserId: 'reviewer' });

  assert.equal(approved.state, 'IMAGE_QUEUED');
  assert.equal(fixture.assessments.at(-1).copy_revision_id, 13);
  assert.equal(fixture.assessments.at(-1).rating_context, 'EDITED');
  assert.equal(fixture.assessments.at(-1).score_x10, 25);
  assert.equal(fixture.assessments.at(-1).action, 'APPROVE');
});

test('editing an already edited revision appends only the new edited-version rating', async () => {
  const fixture = copyFixture();
  await fixture.repository.approveCopy(41, {
    revisionId: 12, nodeId: 'node-a', decision: 'SAVE',
    originalScore: 2, originalReasons: ['STRUCTURE'],
    edits: validEdits, score: 2.5, reasons: ['EXPRESSION'], reviewSessionId,
  }, { reviewerUserId: 'reviewer' });
  const priorAssessmentCount = fixture.assessments.length;

  const savedAgain = await fixture.repository.approveCopy(41, {
    revisionId: 13,
    nodeId: 'node-a',
    decision: 'SAVE',
    edits: { ...validEdits, copy: { ...validEdits.copy, title: '第二次整理后的实用方法' } },
    score: 2.5,
    reasons: ['TITLE'],
    reviewSessionId: '99999999-9999-4999-8999-999999999999',
  }, { reviewerUserId: 'reviewer' });

  assert.equal(savedAgain.state, 'COPY_REVIEW_PENDING');
  assert.equal(savedAgain.currentCopyRevisionId, 14);
  assert.equal(fixture.assessments.length, priorAssessmentCount + 1);
  assert.equal(fixture.assessments.at(-1).copy_revision_id, 14);
  assert.equal(fixture.assessments.at(-1).rating_context, 'EDITED');
});

test('copy score validation and the greater-than-two approval threshold happen before database mutation', async () => {
  const repository = new PostgresControlPlaneRepository({
    pool: { connect: async () => assert.fail('invalid rating must not connect') },
  });
  const base = { revisionId: 12, nodeId: 'node-a', decision: 'APPROVE', reviewSessionId };
  const actor = { reviewerUserId: 'reviewer' };

  for (const originalScore of [0, 1.5, 2.25, 4, '2.5', null]) {
    await assert.rejects(repository.approveCopy(41, { ...base, originalScore, note: '有问题' }, actor), TypeError);
  }
  for (const originalScore of [1, 2]) {
    await assert.rejects(repository.approveCopy(41, { ...base, originalScore, note: '需要修改' }, actor), {
      code: 'QUALITY_SCORE_TOO_LOW',
    });
  }
  await assert.rejects(repository.approveCopy(41, { ...base, decision: 'SAVE', originalScore: 2.5 }, actor),
    /requires at least one reason or a note/u);
});

test('unassigned copy review is rejected before idempotency or rating writes', async () => {
  const fixture = copyFixture({ assignedToUserId: null });
  await assert.rejects(fixture.repository.approveCopy(41, {
    revisionId: 12,
    nodeId: 'node-a',
    decision: 'APPROVE',
    score: 3,
    reviewSessionId,
  }, { reviewerUserId: 'reviewer' }), {
    code: 'TASK_ASSIGNEE_REQUIRED',
    message: '未分配任务不能进行文案审核，请先指定负责人',
  });

  assert.equal(fixture.assessments.length, 0);
  assert.equal(fixture.queries.some(({ sql }) => sql.includes('human_quality_review_submissions')), false);
  assert.equal(fixture.queries.some(({ sql }) => sql.includes('copy_revisions')), false);
  assert.equal(fixture.queries.some(({ sql }) => /^\s*UPDATE\s+tasks\b/u.test(sql)), false);
  assert.equal(fixture.queries.at(-1).sql, 'ROLLBACK');
});

test('discarding copy records its rating and cancels the task without creating an edited revision', async () => {
  const fixture = copyFixture();
  const discarded = await fixture.repository.approveCopy(41, {
    revisionId: 12,
    nodeId: 'node-a',
    decision: 'DISCARD',
    originalScore: 1,
    reasons: ['FACT_OR_COMPLIANCE'],
    reviewSessionId,
  }, { reviewerUserId: 'reviewer' });

  assert.equal(discarded.state, 'CANCELLED');
  assert.equal(fixture.assessments.length, 1);
  assert.equal(fixture.assessments[0].action, 'DISCARD');
  assert.equal(fixture.assessments[0].copy_revision_id, 12);
  assert.equal(fixture.queries.some(({ sql }) => sql.includes('INSERT INTO copy_revisions')), false);
  const update = fixture.queries.find(({ sql }) => sql.includes("state = 'CANCELLED'"));
  assert.match(update.sql, /cancelled_from_state = state/u);
  assert.doesNotMatch(update.sql, /IMAGE_QUEUED/u);
});

test('task detail exposes append-only human rating history without changing automatic QC data', async () => {
  const automaticQc = { overallScore: 3 };
  const pool = { async query(sql) {
    const source = String(sql);
    if (source.includes('SELECT * FROM tasks WHERE id = $1')) return { rows: [{
      id: 41, input: { qc: automaticQc }, requested_image_count: '3', state: 'COPY_REVIEW_PENDING', progress_percent: 100,
    }] };
    if (source.includes('FROM human_quality_assessments')) return { rows: [{
      id: 9, task_id: 41, stage: 'COPY', copy_revision_id: 12, image_run_id: null,
      score_x10: 25, rating_context: 'ORIGINAL', action: 'SAVE', reason_codes: ['STRUCTURE'],
      problem_asset_ids: [], note: null, reviewer_username: 'reviewer', review_session_id: reviewSessionId,
      created_at: '2026-09-07T01:00:00Z',
    }] };
    return { rows: [] };
  } };
  const task = await new PostgresControlPlaneRepository({ pool }).getTask(41);

  assert.equal(task.input.qc, automaticQc);
  assert.deepEqual(task.humanQualityAssessments, [{
    id: 9, taskId: 41, stage: 'COPY', copyRevisionId: 12, imageRunId: null,
    score: 2.5, scoreX10: 25, ratingContext: 'ORIGINAL', action: 'SAVE', reasonCodes: ['STRUCTURE'],
    problemAssetIds: [], note: null, reviewerUsername: 'reviewer', reviewSessionId,
    createdAt: '2026-09-07T01:00:00Z',
  }]);
});
