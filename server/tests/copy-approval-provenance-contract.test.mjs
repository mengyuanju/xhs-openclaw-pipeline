import assert from 'node:assert/strict';
import test from 'node:test';

import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';

function rejectionFixture({ mandatoryCopyQc, copyContentChangedFromMachine, copyReworkSatisfied, assessment }) {
  const queries = [];
  const task = {
    id: 41,
    state: 'COPY_REVIEW_PENDING',
    assigned_to_user_id: 'reviewer',
    current_copy_revision_id: 12,
    current_image_run_id: null,
    ai_disclosure_enabled: true,
    mandatory_copy_qc: mandatoryCopyQc,
    production_batch_id: 27,
  };
  const revision = {
    id: 12,
    task_id: 41,
    revision: 2,
    execution_id: null,
    revision_origin: mandatoryCopyQc ? 'QA_RETURN' : 'PLAN_EDIT',
    copy_content_changed_from_machine: copyContentChangedFromMachine,
    copy_rework_satisfied: copyReworkSatisfied,
    content: { copy: { title: '当前标题', body: '当前正文', tags: [] }, imagePlan: [] },
  };
  const client = {
    release() {},
    async query(sql, values = []) {
      const source = String(sql).replace(/\s+/gu, ' ').trim();
      queries.push(source);
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(source)) return { rows: [] };
      if (source.startsWith('SELECT * FROM tasks WHERE id = $1 FOR UPDATE')) return { rows: [{ ...task }] };
      if (source.startsWith('INSERT INTO human_quality_review_submissions')) {
        return { rows: [{ review_session_id: values[0] }] };
      }
      if (source.startsWith('SELECT * FROM copy_revisions WHERE id = $1')) return { rows: [{ ...revision }] };
      if (source.startsWith('SELECT id FROM executor_nodes')) return { rows: [{ id: 'node-a' }] };
      if (source.startsWith('SELECT * FROM human_quality_assessments')) {
        return { rows: assessment ? [{
          id: 501,
          task_id: 41,
          stage: 'COPY',
          copy_revision_id: 12,
          score_x10: assessment.scoreX10,
          rating_context: assessment.ratingContext ?? 'ORIGINAL',
          action: 'SAVE',
          reason_codes: assessment.reasonCodes ?? ['IMAGE_PLAN'],
          problem_asset_ids: [],
          note: assessment.note ?? null,
          reviewer_username: 'reviewer',
        }] : [] };
      }
      throw new Error(`unexpected SQL: ${source}`);
    },
  };
  return {
    queries,
    repository: new PostgresControlPlaneRepository({ pool: { connect: async () => client } }),
  };
}

function approveInput(reviewSessionId) {
  return {
    revisionId: 12,
    nodeId: 'node-a',
    decision: 'APPROVE',
    score: 3,
    reasons: [],
    note: '',
    reviewSessionId,
  };
}

test('a plan-only saved revision cannot turn a below-3 copy into an automatic 3 approval', async () => {
  const fixture = rejectionFixture({
    mandatoryCopyQc: false,
    copyContentChangedFromMachine: false,
    copyReworkSatisfied: false,
    assessment: { scoreX10: 25, reasonCodes: ['IMAGE_PLAN'] },
  });
  await assert.rejects(fixture.repository.approveCopy(41,
    approveInput('11111111-1111-4111-8111-111111111111'),
    { actorRole: 'ADMIN', reviewerUserId: 'reviewer' }), { code: 'COPY_EDIT_REQUIRED' });
  assert.equal(fixture.queries.at(-1), 'ROLLBACK');
  assert.equal(fixture.queries.some((sql) => sql.startsWith('UPDATE copy_revisions')), false);
});
test('a QA-return revision cannot be approved until copy changed relative to that return', async () => {
  const fixture = rejectionFixture({
    mandatoryCopyQc: true,
    copyContentChangedFromMachine: true,
    copyReworkSatisfied: false,
    assessment: null,
  });
  await assert.rejects(fixture.repository.approveCopy(41,
    approveInput('22222222-2222-4222-8222-222222222222'),
    { actorRole: 'ADMIN', reviewerUserId: 'reviewer' }), {
    code: 'COPY_REWORK_NOT_SATISFIED',
    message: /修改标题、正文或标签后再提交强制复检/u,
  });
  assert.equal(fixture.queries.at(-1), 'ROLLBACK');
  assert.equal(fixture.queries.some((sql) => sql.startsWith('UPDATE copy_revisions')), false);
});
