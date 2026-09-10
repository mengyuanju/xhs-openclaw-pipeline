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

const sourceEdits = {
  ...validEdits,
  copy: { ...validEdits.copy, title: '需要修改的桌面整理方法' },
};

function copyFixture({ assignedToUserId = 'reviewer' } = {}) {
  const task = {
    id: 41,
    state: 'COPY_REVIEW_PENDING',
    assigned_to_user_id: assignedToUserId,
    current_copy_revision_id: 12,
    current_image_run_id: null,
    production_batch_id: null,
    mandatory_copy_qc: false,
    ai_disclosure_enabled: true,
    progress_percent: 100,
  };
  const queries = [];
  const assessments = [];
  const approvalEvents = [];
  const submissions = [];
  const revisions = new Map([[12, {
    id: 12, task_id: 41, revision: 1, execution_id: sourceExecutionId, content: sourceEdits,
    copy_content_changed_from_machine: false, copy_rework_satisfied: false,
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
      if (source.includes('WITH RECURSIVE copy_lineage')) {
        let revision = revisions.get(Number(values[0]));
        while (revision && revision.execution_id === null && revision.parent_revision_id !== null) {
          revision = revisions.get(Number(revision.parent_revision_id));
        }
        return { rows: revision?.execution_id ? [{ content: revision.content }] : [] };
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
        const revision = {
          id: nextRevision++, task_id: 41, revision: values[1], execution_id: null, content: values[2],
          parent_revision_id: values[5], revision_origin: values[6],
          copy_content_changed_from_machine: values[7], copy_rework_satisfied: values[8],
        };
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
      if (source.includes('INSERT INTO copy_approval_events')) {
        const row = {
          id: approvalEvents.length + 1,
          task_id: values[0], copy_revision_id: values[1], assessment_id: values[2],
          approval_mode: values[3], approved_by_account_id: values[4], approved_by_username: values[5],
          review_session_id: values[6], content_sha256: values[7],
        };
        approvalEvents.push(row);
        return { rows: [row] };
      }
      if (source.includes('FROM copy_approval_events')) {
        return { rows: approvalEvents.filter((row) => row.task_id === Number(values[0])
          && row.copy_revision_id === Number(values[1])) };
      }
      if (source.includes('FROM human_quality_assessments')) {
        return { rows: assessments
          .filter((row) => row.task_id === Number(values[0]) && row.copy_revision_id === Number(values[1]))
          .toSorted((left, right) => right.id - left.id)
          .slice(0, 1) };
      }
      if (source.includes('UPDATE tasks SET')) {
        const routesApprovedCopy = source.includes('state = $2');
        Object.assign(task, {
          state: routesApprovedCopy ? values[1]
            : source.includes("state = 'IMAGE_QUEUED'") ? 'IMAGE_QUEUED'
            : source.includes("state = 'CANCELLED'") ? 'CANCELLED' : 'COPY_REVIEW_PENDING',
          current_copy_revision_id: (routesApprovedCopy ? values[2] : values[1]) ?? task.current_copy_revision_id,
        });
        return { rows: [{ ...task }] };
      }
      if (source.includes('UPDATE copy_revisions')) {
        const revision = revisions.get(Number(values[0]));
        if (!revision) return { rows: [] };
        Object.assign(revision, { approved_at: new Date(), approved_by_node_id: values[1], approval_mode: 'MANUAL' });
        return { rows: [revision] };
      }
      throw new Error(`Unexpected SQL: ${source}`);
    },
  };
  return { task, queries, assessments, approvalEvents, revisions,
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

test('a saved edited revision can be reopened and approved with the automatic final score of three', async () => {
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
    score: 3,
    reasons: [],
    reviewSessionId: '88888888-8888-4888-8888-888888888888',
  }, { reviewerUserId: 'reviewer' });

  assert.equal(approved.state, 'IMAGE_QUEUED');
  assert.equal(fixture.assessments.at(-1).copy_revision_id, 13);
  assert.equal(fixture.assessments.at(-1).rating_context, 'EDITED');
  assert.equal(fixture.assessments.at(-1).score_x10, 30);
  assert.equal(fixture.assessments.at(-1).action, 'APPROVE');
});

test('a low-score machine draft cannot be edited and then restored to the machine copy for approval', async () => {
  const fixture = copyFixture();
  await fixture.repository.approveCopy(41, {
    revisionId: 12,
    nodeId: 'node-a',
    decision: 'SAVE',
    originalScore: 2,
    originalReasons: ['STRUCTURE'],
    edits: validEdits,
    score: 2.5,
    reasons: ['EXPRESSION'],
    reviewSessionId,
  }, { reviewerUserId: 'reviewer' });

  await assert.rejects(fixture.repository.approveCopy(41, {
    revisionId: 13,
    nodeId: 'node-a',
    decision: 'APPROVE',
    edits: sourceEdits,
    score: 3,
    reasons: [],
    reviewSessionId: '56565656-5656-4656-8656-565656565656',
  }, { reviewerUserId: 'reviewer' }), {
    code: 'COPY_EDIT_REQUIRED',
  });

  assert.equal(fixture.task.state, 'COPY_REVIEW_PENDING');
  assert.equal(fixture.task.current_copy_revision_id, 13);
  assert.equal(fixture.revisions.size, 2);
  assert.equal(fixture.assessments.length, 2);
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

test('plan-only edits can be saved for a two-point draft or approved only for a three-point draft', async () => {
  for (const { score, decision } of [{ score: 2, decision: 'SAVE' }, { score: 3, decision: 'APPROVE' }]) {
    const fixture = copyFixture();
    const reasons = score === 3 ? [] : ['IMAGE_PLAN'];
    const planOnlyEdits = {
      ...sourceEdits,
      imagePlan: sourceEdits.imagePlan.map((item, index) => index === 0
        ? { ...item, headline: `规划调整 ${score}` }
        : item),
    };
    const saved = await fixture.repository.approveCopy(41, {
      revisionId: 12,
      nodeId: 'node-a',
      decision,
      originalScore: score,
      originalReasons: reasons,
      edits: planOnlyEdits,
      score,
      reasons,
      reviewSessionId: `77777777-7777-4777-8777-7777777777${String(score * 10).padStart(2, '0')}`,
    }, { actorRole: 'ADMIN', reviewerUserId: 'reviewer' });

    assert.equal(saved.currentCopyRevisionId, 13);
    assert.equal(fixture.assessments.length, 1);
    assert.equal(fixture.assessments[0].copy_revision_id, 13);
    assert.equal(fixture.assessments[0].score_x10, score * 10);
    assert.equal(fixture.assessments[0].rating_context, 'ORIGINAL');
  }

  for (const { score, decision, code } of [
    { score: 1, decision: 'SAVE', code: 'SCORE_ONE_REQUIRES_DISCARD' },
    { score: 2.5, decision: 'APPROVE', code: 'COPY_EDIT_REQUIRED' },
  ]) {
    const fixture = copyFixture();
    const planOnlyEdits = {
      ...sourceEdits,
      imagePlan: sourceEdits.imagePlan.map((item, index) => index === 0
        ? { ...item, headline: `规划调整 ${score}` }
        : item),
    };
    await assert.rejects(fixture.repository.approveCopy(41, {
      revisionId: 12,
      nodeId: 'node-a',
      decision,
      originalScore: score,
      originalReasons: ['IMAGE_PLAN'],
      edits: planOnlyEdits,
      score: decision === 'APPROVE' ? 3 : score,
      reasons: decision === 'APPROVE' ? [] : ['IMAGE_PLAN'],
      reviewSessionId: `67676767-6767-4767-8767-6767676767${String(score * 10).padStart(2, '0')}`,
    }, { actorRole: 'ADMIN', reviewerUserId: 'reviewer' }), { code });
    assert.equal(fixture.revisions.size, 1);
    assert.equal(fixture.assessments.length, 0);
  }
});

test('a plan-only saved low-score revision still requires a real copy edit before approval', async () => {
  const fixture = copyFixture();
  const planOnlyEdits = {
    ...sourceEdits,
    imagePlan: sourceEdits.imagePlan.map((item, index) => index === 0
      ? { ...item, headline: '仅保存图片文案规划' }
      : item),
  };

  await fixture.repository.approveCopy(41, {
    revisionId: 12,
    nodeId: 'node-a',
    decision: 'SAVE',
    originalScore: 2.5,
    originalReasons: ['IMAGE_PLAN'],
    originalNote: '数据库中的原始评分说明',
    edits: planOnlyEdits,
    score: 2.5,
    reasons: ['IMAGE_PLAN'],
    note: '数据库中的原始评分说明',
    reviewSessionId: '12121212-1212-4212-8212-121212121212',
  }, { actorRole: 'ADMIN', reviewerUserId: 'reviewer' });

  await assert.rejects(fixture.repository.approveCopy(41, {
    revisionId: 13,
    nodeId: 'node-a',
    decision: 'APPROVE',
    score: 3,
    reasons: ['FORGED_CLIENT_REASON'],
    note: '客户端伪造的评分说明',
    reviewSessionId: '13131313-1313-4313-8313-131313131313',
  }, { actorRole: 'ADMIN', reviewerUserId: 'reviewer' }), { code: 'COPY_EDIT_REQUIRED' });

  assert.equal(fixture.task.state, 'COPY_REVIEW_PENDING');
  assert.equal(fixture.task.current_copy_revision_id, 13);
  assert.equal(fixture.assessments.length, 1);
  assert.equal(fixture.assessments[0].score_x10, 25);
  assert.equal(fixture.assessments[0].rating_context, 'ORIGINAL');
});

test('a forged passing client score cannot approve a plan-only revision with a stored low score', async () => {
  const fixture = copyFixture();
  const planOnlyEdits = {
    ...sourceEdits,
    imagePlan: sourceEdits.imagePlan.map((item, index) => index === 1
      ? { ...item, subtitle: '低分时仍可保存规划' }
      : item),
  };

  await fixture.repository.approveCopy(41, {
    revisionId: 12,
    nodeId: 'node-a',
    decision: 'SAVE',
    originalScore: 2,
    originalReasons: ['STRUCTURE'],
    originalNote: '需要继续修改文案',
    edits: planOnlyEdits,
    score: 2,
    reasons: ['STRUCTURE'],
    note: '需要继续修改文案',
    reviewSessionId: '14141414-1414-4414-8414-141414141414',
  }, { actorRole: 'ADMIN', reviewerUserId: 'reviewer' });

  await assert.rejects(fixture.repository.approveCopy(41, {
    revisionId: 13,
    nodeId: 'node-a',
    decision: 'APPROVE',
    score: 3,
    reasons: [],
    note: '',
    reviewSessionId: '15151515-1515-4515-8515-151515151515',
  }, { actorRole: 'ADMIN', reviewerUserId: 'reviewer' }), {
    code: 'COPY_EDIT_REQUIRED',
  });

  assert.equal(fixture.task.state, 'COPY_REVIEW_PENDING');
  assert.equal(fixture.task.current_copy_revision_id, 13);
  assert.equal(fixture.revisions.size, 2);
  assert.equal(fixture.assessments.length, 1);
  assert.equal(fixture.assessments[0].score_x10, 20);
  assert.equal(fixture.assessments[0].rating_context, 'ORIGINAL');
});

test('copy edits require an editable base score while plan-only edits do not', async () => {
  for (const originalScore of [1, 3]) {
    const fixture = copyFixture();
    await assert.rejects(fixture.repository.approveCopy(41, {
      revisionId: 12,
      nodeId: 'node-a',
      decision: 'SAVE',
      originalScore,
      originalReasons: originalScore === 3 ? [] : ['STRUCTURE'],
      edits: validEdits,
      score: 2.5,
      reasons: ['EXPRESSION'],
      reviewSessionId: `88888888-8888-4888-8888-8888888888${String(originalScore).padStart(2, '0')}`,
    }, { actorRole: 'ADMIN', reviewerUserId: 'reviewer' }), {
      code: 'COPY_EDIT_SCORE_NOT_ALLOWED',
    });
    assert.equal(fixture.assessments.length, 0);
    assert.equal(fixture.queries.some(({ sql }) => sql.includes('INSERT INTO copy_revisions')), false);
  }
});

test('copy edits on a manual revision use its latest stored base score', async () => {
  const fixture = copyFixture();
  await fixture.repository.approveCopy(41, {
    revisionId: 12,
    nodeId: 'node-a',
    decision: 'SAVE',
    originalScore: 2,
    originalReasons: ['STRUCTURE'],
    edits: validEdits,
    score: 3,
    reasons: [],
    reviewSessionId,
  }, { reviewerUserId: 'reviewer' });

  await assert.rejects(fixture.repository.approveCopy(41, {
    revisionId: 13,
    nodeId: 'node-a',
    decision: 'SAVE',
    edits: { ...validEdits, copy: { ...validEdits.copy, title: '试图绕过三分正文锁定' } },
    originalScore: 2,
    originalReasons: ['STRUCTURE'],
    score: 2.5,
    reasons: ['TITLE'],
    reviewSessionId: '99999999-9999-4999-8999-999999999998',
  }, { reviewerUserId: 'reviewer' }), {
    code: 'COPY_EDIT_SCORE_NOT_ALLOWED',
  });
  assert.equal(fixture.revisions.size, 2);
  assert.equal(fixture.assessments.length, 2);
});

test('a stored machine-original rating overrides a forged submitted base score', async () => {
  const fixture = copyFixture();
  await fixture.repository.approveCopy(41, {
    revisionId: 12,
    nodeId: 'node-a',
    decision: 'SAVE',
    score: 3,
    reasons: [],
    reviewSessionId: '33333333-3333-4333-8333-333333333333',
  }, { reviewerUserId: 'reviewer' });

  await fixture.repository.approveCopy(41, {
    revisionId: 12,
    nodeId: 'node-a',
    decision: 'SAVE',
    score: 2,
    reasons: ['STRUCTURE'],
    reviewSessionId: '23232323-2323-4323-8323-232323232323',
  }, { reviewerUserId: 'reviewer' });

  assert.equal(fixture.assessments.length, 2);
  assert.equal(fixture.assessments.at(-1).score_x10, 30,
    'a no-edit request cannot replace the stored score used by later edit authorization');

  await assert.rejects(fixture.repository.approveCopy(41, {
    revisionId: 12,
    nodeId: 'node-a',
    decision: 'SAVE',
    originalScore: 2,
    originalReasons: ['STRUCTURE'],
    edits: validEdits,
    score: 2.5,
    reasons: ['TITLE'],
    reviewSessionId: '22222222-2222-4222-8222-222222222222',
  }, { reviewerUserId: 'reviewer' }), {
    code: 'COPY_EDIT_SCORE_NOT_ALLOWED',
  });

  assert.equal(fixture.revisions.size, 1);
  assert.equal(fixture.assessments.length, 2);
  assert.ok(fixture.assessments.every((assessment) => assessment.score_x10 === 30));
});

test('an unrated legacy manual revision accepts only an explicit validated base rating', async () => {
  const fixture = copyFixture();
  fixture.revisions.set(12, {
    ...fixture.revisions.get(12),
    execution_id: null,
  });
  const edited = { ...validEdits, copy: { ...validEdits.copy, title: '历史版本补评分后修改' } };

  await assert.rejects(fixture.repository.approveCopy(41, {
    revisionId: 12,
    nodeId: 'node-a',
    decision: 'SAVE',
    edits: edited,
    score: 2.5,
    reasons: ['TITLE'],
    reviewSessionId: '55555555-5555-4555-8555-555555555555',
  }, { reviewerUserId: 'reviewer' }), {
    code: 'COPY_BASE_RATING_REQUIRED',
  });

  const saved = await fixture.repository.approveCopy(41, {
    revisionId: 12,
    nodeId: 'node-a',
    decision: 'SAVE',
    originalScore: 2,
    originalReasons: ['STRUCTURE'],
    edits: edited,
    score: 2.5,
    reasons: ['TITLE'],
    reviewSessionId: '44444444-4444-4444-8444-444444444444',
  }, { reviewerUserId: 'reviewer' });

  assert.equal(saved.currentCopyRevisionId, 13);
  assert.deepEqual(fixture.assessments.map(({ copy_revision_id, score_x10, rating_context }) => ({
    copyRevisionId: copy_revision_id,
    scoreX10: score_x10,
    ratingContext: rating_context,
  })), [
    { copyRevisionId: 12, scoreX10: 20, ratingContext: 'EDITED' },
    { copyRevisionId: 13, scoreX10: 25, ratingContext: 'EDITED' },
  ]);
});

test('plan-only edits after a real copy edit preserve provenance but approval records final score three', async () => {
  const fixture = copyFixture();
  await fixture.repository.approveCopy(41, {
    revisionId: 12,
    nodeId: 'node-a',
    decision: 'SAVE',
    originalScore: 2,
    originalReasons: ['STRUCTURE'],
    edits: validEdits,
    score: 2.5,
    reasons: ['EXPRESSION'],
    reviewSessionId,
  }, { reviewerUserId: 'reviewer' });
  const priorAssessmentCount = fixture.assessments.length;

  const saved = await fixture.repository.approveCopy(41, {
    revisionId: 13,
    nodeId: 'node-a',
    decision: 'APPROVE',
    edits: {
      ...validEdits,
      imagePlan: validEdits.imagePlan.map((item, index) => index === 1
        ? { ...item, subtitle: '只调整图片文案规划' }
        : item),
    },
    // The repository must carry the bound base assessment for plan-only edits,
    // rather than trusting a client to re-rate unchanged copy.
    score: 3,
    reasons: [],
    reviewSessionId: '66666666-6666-4666-8666-666666666666',
  }, { reviewerUserId: 'reviewer' });

  assert.equal(saved.currentCopyRevisionId, 14);
  assert.equal(fixture.assessments.length, priorAssessmentCount + 1);
  assert.deepEqual(
    fixture.assessments.slice(-1).map(({ copy_revision_id, score_x10, rating_context, reason_codes }) => ({
      copyRevisionId: copy_revision_id,
      scoreX10: score_x10,
      ratingContext: rating_context,
      reasonCodes: reason_codes,
    })),
    [{ copyRevisionId: 14, scoreX10: 30, ratingContext: 'EDITED', reasonCodes: [] }],
  );
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
