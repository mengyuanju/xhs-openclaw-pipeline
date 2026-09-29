import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { decideCopyQaItemV2, routeCopyApprovalV2 } from '../src/copy-qa-v2.mjs';
import { insertCopyApprovalEvent } from '../src/copy-quality-control.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { startTemporaryPostgres18 } from './temporary-postgres18.mjs';

const content = {
  copy: {
    title: 'Desk setup checklist',
    body: 'Group items by daily use, remove unused objects, and keep each item in its own place. '.repeat(6).trim(),
    tags: ['#DeskSetup', '#Organization', '#DailyReset'],
  },
  imagePlan: [
    { kind: 'hero', headline: 'Clear the desk', subtitle: '',
      bullets: ['Remove unused items', 'Keep daily essentials'],
      prompt: 'A clear desk with daily essentials under natural daylight', layout: { mode: 'CUSTOM' } },
    { kind: 'steps', headline: 'Sort by usage', subtitle: '',
      bullets: ['Group daily items', 'Store rarely used items'],
      prompt: 'A desk with items grouped by frequency of use' },
    { kind: 'summary', headline: 'Daily reset', subtitle: '',
      bullets: ['Return items after use', 'Check the setup weekly'],
      prompt: 'A tidy desk with organized storage compartments' },
  ],
};

async function persistedTask(pool, taskId) {
  return (await pool.query(`SELECT jsonb_build_object(
    'task', (SELECT to_jsonb(task) FROM tasks AS task WHERE id = $1),
    'revisions', (SELECT jsonb_agg(to_jsonb(revision) ORDER BY id)
      FROM copy_revisions AS revision WHERE task_id = $1),
    'approvals', (SELECT jsonb_agg(to_jsonb(approval) ORDER BY id)
      FROM copy_approval_events AS approval WHERE task_id = $1),
    'submissions', (SELECT jsonb_agg(to_jsonb(submission) ORDER BY review_session_id)
      FROM human_quality_review_submissions AS submission WHERE task_id = $1),
    'assessments', (SELECT jsonb_agg(to_jsonb(assessment) ORDER BY id)
      FROM human_quality_assessments AS assessment WHERE task_id = $1),
    'members', (SELECT jsonb_agg(to_jsonb(member) ORDER BY id)
      FROM copy_qa_batch_members_v2 AS member WHERE task_id = $1),
    'batches', (SELECT jsonb_agg(to_jsonb(batch) ORDER BY id)
      FROM copy_qa_batches_v2 AS batch WHERE EXISTS (
        SELECT 1 FROM copy_qa_batch_members_v2 AS member
        WHERE member.batch_id = batch.id AND member.task_id = $1))
  ) AS snapshot`, [taskId])).rows[0].snapshot;
}

async function qualityMembers(pool, taskId) {
  return (await pool.query(`SELECT member.*, batch.full_inspection, batch.member_count,
    batch.sample_count, batch.status AS batch_status
    FROM copy_qa_batch_members_v2 AS member
    JOIN copy_qa_batches_v2 AS batch ON batch.id = member.batch_id
    WHERE member.task_id = $1 ORDER BY member.id`, [taskId])).rows;
}

async function imageEligibility(pool, taskId) {
  return (await pool.query(`SELECT state, current_copy_revision_id, copy_qc_released_revision_id,
    mandatory_copy_qc, mandatory_copy_qc_origin,
    copy_quality_image_eligible(id, current_copy_revision_id, mandatory_copy_qc) AS eligible
    FROM tasks WHERE id = $1`, [taskId])).rows[0];
}

test('PostgreSQL: image retry exhaustion starts a new rework round after a passed QA correction', {
  skip: process.env.RUN_POSTGRES_E2E !== '1', timeout: 120_000,
}, async t => {
  const postgres = await startTemporaryPostgres18('xhs-image-retry-rework-');
  const repository = new PostgresControlPlaneRepository({ connectionString: postgres.connectionString });
  const pool = repository.pool;
  t.after(async () => { await repository.close(); await postgres.stop(); });
  await repository.initialize();
  await pool.query("INSERT INTO executor_nodes(id, name) VALUES ('retry-rework-node', 'Test node')");
  const actors = [];
  for (const [username, role, copyQcEnabled] of [
    ['retry-rework-worker', 'USER', false], ['retry-rework-reviewer', 'REVIEWER', true],
  ]) {
    const row = (await pool.query(`INSERT INTO app_users(username, display_name, role, password_hash,
      copy_review_enabled, copy_qc_enabled) VALUES ($1, $1, $2, 'test-only', true, $3) RETURNING *`,
    [username, role, copyQcEnabled])).rows[0];
    actors.push({ userId: Number(row.id), username, role, credentialVersion: Number(row.credential_version) });
  }
  const [worker, reviewer] = actors;

  async function exhaustedTask() {
    const task = (await pool.query(`INSERT INTO tasks(query, created_by_node_id, state,
      assigned_to_user_id, assignment_source, assigned_at, mandatory_copy_qc, mandatory_copy_qc_origin)
      VALUES ('Image retry rework fixture', 'retry-rework-node', 'COPY_QC_PENDING', $1,
        'MANUAL', now(), true, 'QA_RETURN') RETURNING *`, [worker.username])).rows[0];
    const returnedContent = { ...structuredClone(content), qualityReturn: {
      origin: 'QA_RETURN', target: 'COPY', note: 'The title needs a correction',
    } };
    const returnedRevision = (await pool.query(`INSERT INTO copy_revisions(task_id, revision,
      content, revision_origin) VALUES ($1, 1, $2, 'QA_RETURN') RETURNING *`,
    [task.id, returnedContent])).rows[0];
    const approvedContent = structuredClone(returnedContent);
    approvedContent.copy.title = 'Practical desk checklist';
    const approvedRevision = (await pool.query(`INSERT INTO copy_revisions(task_id, revision,
      content, parent_revision_id, revision_origin, approved_at, approved_by_node_id,
      approval_mode, copy_content_changed_from_machine, copy_rework_satisfied)
      VALUES ($1, 2, $2, $3, 'COPY_EDIT', now(), 'retry-rework-node', 'MANUAL', true, true)
      RETURNING *`, [task.id, approvedContent, returnedRevision.id])).rows[0];
    await pool.query('UPDATE tasks SET current_copy_revision_id = $2 WHERE id = $1',
      [task.id, approvedRevision.id]);
    const approval = await insertCopyApprovalEvent(pool, { taskId: Number(task.id),
      copyRevisionId: Number(approvedRevision.id), actor: worker, content: approvedRevision.content });
    await routeCopyApprovalV2(pool, { task, revision: approvedRevision, approval,
      actor: worker, aiDisclosureEnabled: true });
    const [passedMember] = await qualityMembers(pool, task.id);
    await decideCopyQaItemV2(pool, passedMember.public_id, { requestId: randomUUID(),
      revisionToken: passedMember.content_sha256, decision: 'PASS' }, reviewer);
    assert.equal((await imageEligibility(pool, task.id)).state, 'IMAGE_QUEUED');

    // Image failures return the already-approved revision without creating a QA_RETURN revision.
    await pool.query(`UPDATE tasks SET state = 'COPY_REVIEW_PENDING',
      current_stage = 'IMAGE_RETRY_EXHAUSTED', mandatory_copy_qc = true,
      mandatory_copy_qc_origin = 'IMAGE_RETRY_REVIEW', pending_snapshot = NULL,
      error = 'Synthetic image execution failures' WHERE id = $1`, [task.id]);
    return { taskId: Number(task.id), revisionId: Number(approvedRevision.id), approvedContent,
      passedMember: (await qualityMembers(pool, task.id))[0] };
  }

  for (const editKind of ['COPY', 'PLAN']) {
    await t.test(`${editKind} edits require a distinct mandatory inspection before images can restart`, async () => {
      const fixture = await exhaustedTask();
      const submit = edits => repository.approveCopy(fixture.taskId, {
        revisionId: fixture.revisionId, nodeId: 'retry-rework-node', decision: 'APPROVE',
        reviewSessionId: randomUUID(), ...(edits ? { edits } : {}),
      }, { actor: worker });
      const before = await persistedTask(pool, fixture.taskId);
      for (const unchanged of [undefined, fixture.approvedContent,
        { ...structuredClone(fixture.approvedContent), imageSettings: { format: 'JPEG' } }]) {
        await assert.rejects(submit(unchanged), { code: 'COPY_REWORK_NOT_SATISFIED' });
        assert.deepEqual(await persistedTask(pool, fixture.taskId), before,
          'rejected submissions must roll back approval, revision, rating and QA records');
      }
      assert.equal((await imageEligibility(pool, fixture.taskId)).eligible, false);

      const edits = structuredClone(fixture.approvedContent);
      if (editKind === 'COPY') edits.copy.title = 'Clear desk checklist';
      else edits.imagePlan[0].subtitle = 'Keep only daily essentials';
      const request = { revisionId: fixture.revisionId, nodeId: 'retry-rework-node',
        decision: 'APPROVE', reviewSessionId: randomUUID(), edits };
      const approved = await repository.approveCopy(fixture.taskId, request, { actor: worker });
      assert.equal(approved.state, 'COPY_QC_PENDING');
      assert.equal(approved.mandatoryCopyQcOrigin, 'IMAGE_RETRY_REVIEW');
      assert.notEqual(approved.currentCopyRevisionId, fixture.revisionId);
      const newRevision = (await pool.query('SELECT * FROM copy_revisions WHERE id = $1',
        [approved.currentCopyRevisionId])).rows[0];
      assert.ok(newRevision.approved_at);
      assert.equal(Number(newRevision.parent_revision_id), fixture.revisionId);
      assert.equal(newRevision.revision_origin, editKind === 'COPY' ? 'COPY_EDIT' : 'PLAN_EDIT');
      assert.equal(newRevision.copy_rework_satisfied, true);
      if (editKind === 'PLAN') assert.deepEqual(newRevision.content.copy, fixture.approvedContent.copy);
      const members = await qualityMembers(pool, fixture.taskId);
      assert.equal(members.length, 2);
      assert.equal(members[0].status, 'PASSED', 'the preceding passed inspection remains unchanged');
      const recheck = members[1];
      assert.notEqual(recheck.batch_id, fixture.passedMember.batch_id);
      assert.equal(Number(recheck.copy_revision_id), approved.currentCopyRevisionId);
      assert.equal(recheck.selected, true);
      assert.equal(recheck.status, 'PENDING');
      assert.equal(recheck.full_inspection, true);
      assert.equal(recheck.member_count, 1);
      assert.equal(recheck.sample_count, 1);
      assert.equal(recheck.batch_status, 'INSPECTING');
      const held = await imageEligibility(pool, fixture.taskId);
      assert.equal(held.state, 'COPY_QC_PENDING');
      assert.equal(held.copy_qc_released_revision_id, null);
      assert.equal(held.eligible, false);
      const afterApproval = await persistedTask(pool, fixture.taskId);
      const replay = await repository.approveCopy(fixture.taskId, request, { actor: worker });
      assert.equal(replay.currentCopyRevisionId, approved.currentCopyRevisionId);
      assert.deepEqual(await persistedTask(pool, fixture.taskId), afterApproval,
        'replaying an approved submission must not duplicate the new revision or QA member');

      await decideCopyQaItemV2(pool, recheck.public_id, { requestId: randomUUID(),
        revisionToken: recheck.content_sha256, decision: 'PASS' }, reviewer);
      const released = await imageEligibility(pool, fixture.taskId);
      assert.equal(released.state, 'IMAGE_QUEUED');
      assert.equal(Number(released.copy_qc_released_revision_id), approved.currentCopyRevisionId);
      assert.equal(released.mandatory_copy_qc, false);
      assert.equal(released.mandatory_copy_qc_origin, null);
      assert.equal(released.eligible, true);
    });
  }
});
