import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { readTaskDataReport } from '../src/task-data-report.mjs';
import { startTemporaryPostgres18 } from './helpers/personal-postgres.mjs';

const NODE_ID = 'report-reassignment-time-node';
const CONTENT = {
  copy: {
    title: '机器文案',
    body: '先清理不再使用的物品，再按照使用频率划分区域。'.repeat(20),
    tags: ['#整理', '#收纳', '#步骤'],
  },
  imagePlan: [
    { kind: 'hero', headline: '桌面整理', subtitle: '', bullets: ['清空桌面', '展示整理后的样子'],
      prompt: '自然光下展示整洁桌面的真实生活场景' },
    { kind: 'steps', headline: '先做减法', subtitle: '', bullets: ['判断使用频率', '移走不常用物品'],
      prompt: '展示物品分类和筛选过程的真实桌面场景' },
    { kind: 'summary', headline: '固定位置', subtitle: '', bullets: ['每天复位', '保持桌面整洁'],
      prompt: '整洁桌面与标签明确的收纳区域近景画面' },
  ],
};

function beijingDay(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

test('task report keeps its first copy review date through ordinary and secondary reassignments', {
  skip: process.env.RUN_POSTGRES_E2E !== '1', timeout: 180_000,
}, async t => {
  const database = await startTemporaryPostgres18();
  const repository = new PostgresControlPlaneRepository({ connectionString: database.connectionString });
  try {
    await repository.initialize();
    const db = repository.pool;
    await db.query('INSERT INTO executor_nodes(id,name) VALUES($1,$2)', [NODE_ID, '报表改派测试机']);
    const users = (await db.query(`INSERT INTO app_users(
      username,display_name,role,password_hash,status,copy_review_enabled,copy_qc_enabled,image_qc_enabled,created_at)
      VALUES('report-time-admin','管理员','ADMIN','test-only','ACTIVE',true,true,true,now()-interval '30 days'),
        ('report-time-a','标注甲','USER','test-only','ACTIVE',true,false,false,now()-interval '30 days'),
        ('report-time-b','标注乙','USER','test-only','ACTIVE',true,false,false,now()-interval '30 days')
      RETURNING id,username,role,credential_version`)).rows;
    const [admin, annotatorA, annotatorB] = users.map(row => ({
      userId: Number(row.id), username: row.username, role: row.role,
      credentialVersion: Number(row.credential_version),
    }));
    const today = beijingDay(new Date());
    const todayStart = new Date(today + 'T00:00:00+08:00');
    const at = daysAgo => new Date(todayStart.getTime() - daysAgo * 86_400_000 + 12 * 3_600_000);
    const firstReviewAt = at(10);
    const oldApprovalAt = at(8);

    async function createTask(name, withBatch = false) {
      const batchId = withBatch ? Number((await db.query(`INSERT INTO production_batches(
        public_id,query_package_name,created_by_account_id,created_by_username,request_id,
        request_fingerprint,client_batch_code)
        VALUES($1,'报表改派测试',$2,$3,$4,$5,$6) RETURNING id`,
      [randomUUID(), admin.userId, admin.username, randomUUID(), 'a'.repeat(64),
        randomUUID().replaceAll('-', '')])).rows[0].id) : null;
      const taskId = Number((await db.query(`INSERT INTO tasks(
        query,input,state,current_stage,created_by_node_id,created_by_user_id,
        assigned_to_user_id,assignment_source,assigned_at,production_batch_id)
        VALUES($1,'{}','COPY_REVIEW_PENDING','COPY_REVIEW_PENDING',$2,$3,$3,'MANUAL',$4,$5)
        RETURNING id`, [name, NODE_ID, annotatorA.username, at(15), batchId])).rows[0].id);
      const executionId = randomUUID();
      await db.query(`INSERT INTO task_executions(id,task_id,kind,node_id,status,stage,snapshot)
        VALUES($1,$2,'COPY',$3,'SUCCEEDED','COMPLETED','{}')`, [executionId, taskId, NODE_ID]);
      const revisionId = Number((await db.query(`INSERT INTO copy_revisions(
        task_id,execution_id,revision,content,revision_origin)
        VALUES($1,$2,1,$3,'GENERATION') RETURNING id`, [taskId, executionId, CONTENT])).rows[0].id);
      await db.query('UPDATE tasks SET current_copy_revision_id=$2 WHERE id=$1', [taskId, revisionId]);
      return { taskId, revisionId, batchId };
    }

    async function assessment(task, action, createdAt, { stage = 'COPY', revisionId = task.revisionId } = {}) {
      const reviewSessionId = randomUUID();
      const fingerprint = 'b'.repeat(64);
      let imageRunId = null;
      if (stage === 'IMAGE') {
        imageRunId = randomUUID();
        await db.query(`INSERT INTO image_runs(id,task_id,copy_revision_id,status,image_production_chain_id)
          VALUES($1,$2,$3,'COMPLETED',$1)`, [imageRunId, task.taskId, revisionId]);
      }
      await db.query(`INSERT INTO human_quality_review_submissions(
        review_session_id,task_id,stage,reviewer_username,request_fingerprint,created_at)
        VALUES($1,$2,$3,$4,$5,$6)`,
      [reviewSessionId, task.taskId, stage, annotatorA.username, fingerprint, createdAt]);
      return Number((await db.query(`INSERT INTO human_quality_assessments(
        task_id,stage,copy_revision_id,image_run_id,score_x10,rating_context,action,
        reviewer_username,review_session_id,request_fingerprint,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [task.taskId, stage, stage === 'COPY' ? revisionId : null, imageRunId,
        action === 'APPROVE' ? 30 : action === 'DISCARD' ? 10 : 20,
        stage === 'COPY' ? 'ORIGINAL' : 'IMAGE', action, annotatorA.username,
        reviewSessionId, fingerprint, createdAt])).rows[0].id);
    }

    async function reportFor(taskId, from, to = from) {
      return readTaskDataReport(db, admin, {
        time: { field: 'FIRST_COPY_REVIEW_ACTION', mode: 'ABSOLUTE', from, to },
        conditions: [{ field: 'TASK_ID_OR_NAME', op: 'CONTAINS', value: '#' + taskId }],
      });
    }

    async function assertFirstReview(taskId) {
      const original = await reportFor(taskId, beijingDay(firstReviewAt));
      assert.equal(original.total, 1);
      assert.equal(original.summary.total, 1);
      assert.equal(original.items[0].firstCopyReviewAt, firstReviewAt.toISOString());
      assert.equal(original.items[0].reportAt, firstReviewAt.toISOString());
      assert.equal((await reportFor(taskId, beijingDay(at(13)))).total, 0,
        'an earlier IMAGE decision must not become the first COPY review');
      assert.equal((await reportFor(taskId, beijingDay(at(12)))).total, 0,
        'an earlier COPY SAVE must not become the first review decision');
      return original.items[0];
    }

    await t.test('ordinary reassignment and the new annotator approval keep the original date', async () => {
      const task = await createTask('普通改派首次审核');
      await assessment(task, 'RETRY', firstReviewAt);
      await assertFirstReview(task.taskId);
      const reassigned = await repository.assignTask(task.taskId, {
        assignedToUserId: annotatorB.username, assignedToAccountId: annotatorB.userId,
        actor: admin, reason: '报表日期回归测试',
      });
      assert.equal(reassigned.assignedToUserId, annotatorB.username);
      const beforeApproval = await assertFirstReview(task.taskId);
      assert.equal(beforeApproval.reassignmentCount, 1);
      await repository.approveCopy(task.taskId, {
        revisionId: task.revisionId, nodeId: NODE_ID, decision: 'APPROVE', score: 3,
        reviewSessionId: randomUUID(),
        edits: { copy: { ...CONTENT.copy, title: '普通改派后审核稿' }, imagePlan: CONTENT.imagePlan },
      }, { actor: annotatorB });
      const row = await assertFirstReview(task.taskId);
      assert.equal(row.currentAnnotator.accountId, annotatorB.userId);
      assert.equal((await reportFor(task.taskId, today)).total, 0,
        'the new annotator approval must not count the same task again on its new date');
      assert.equal((await reportFor(task.taskId, beijingDay(firstReviewAt), today)).total, 1);
    });

    for (const firstAction of ['RETRY', 'DISCARD']) {
      await t.test('secondary reset archives the first ' + firstAction + ' without changing the report date', async () => {
        const task = await createTask('二次分配首次审核 ' + firstAction, true);
        await assessment(task, 'DISCARD', at(13), { stage: 'IMAGE' });
        await assessment(task, 'SAVE', at(12));
        const firstAssessmentId = await assessment(task, firstAction, firstReviewAt);
        const approvedRevisionId = Number((await db.query(`INSERT INTO copy_revisions(
          task_id,revision,content,revision_origin,parent_revision_id,approved_at,
          approval_mode,copy_content_changed_from_machine)
          VALUES($1,2,$2,'COPY_EDIT',$3,$4,'MANUAL',true) RETURNING id`,
        [task.taskId, { ...CONTENT, copy: { ...CONTENT.copy, title: '历史人工修改稿' } },
          task.revisionId, oldApprovalAt])).rows[0].id);
        const approvalAssessmentId = await assessment(task, 'APPROVE', oldApprovalAt,
          { revisionId: approvedRevisionId });
        const approvalId = Number((await db.query(`INSERT INTO copy_approval_events(
          task_id,copy_revision_id,assessment_id,approval_mode,approved_by_account_id,
          approved_by_username,content_sha256,approved_at)
          VALUES($1,$2,$3,'MANUAL',$4,$5,$6,$7) RETURNING id`,
        [task.taskId, approvedRevisionId, approvalAssessmentId, annotatorA.userId,
          annotatorA.username, 'c'.repeat(64), oldApprovalAt])).rows[0].id);
        await db.query(`UPDATE tasks SET current_copy_revision_id=$2,state='COPY_QC_PENDING',
          current_stage='COPY_QC_PENDING',mandatory_copy_qc=true,mandatory_copy_qc_origin='QA_RETURN'
          WHERE id=$1`, [task.taskId, approvedRevisionId]);
        const freezeId = Number((await db.query(`INSERT INTO copy_sampling_freezes(
          public_id,production_batch_id,policy_version,rate_bps,seed,algorithm_version,
          blind_review_enabled,population_count,sample_count,snapshot_sha256,
          frozen_by_account_id,frozen_by_username,request_id,request_fingerprint)
          VALUES($1,$2,1,10000,'fixture','test',false,1,1,$3,$4,$5,$6,$7) RETURNING id`,
        [randomUUID(), task.batchId, 'd'.repeat(64), admin.userId, admin.username,
          randomUUID(), 'e'.repeat(64)])).rows[0].id);
        const itemPublicId = randomUUID();
        await db.query(`INSERT INTO copy_sampling_items(
          public_id,freeze_id,task_id,approval_event_id,copy_revision_id,content_sha256,
          final_approver_account_id,final_approver_username,rank_hash,selected,status,sample_kind)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$6,true,'PENDING','MANDATORY_RECHECK')`,
        [itemPublicId, freezeId, task.taskId, approvalId, approvedRevisionId,
          'f'.repeat(64), annotatorA.userId, annotatorA.username]);
        await assertFirstReview(task.taskId);

        const receipt = await repository.escalateQualityToAdmin('COPY', itemPublicId, {
          requestId: randomUUID(), expectedRevisionToken: 'f'.repeat(64), note: '复检不通过，二次分配',
        }, { actor: admin });
        const record = await repository.getReassignmentCase(receipt.caseId, { actor: admin });
        assert.equal(record.resetStatus, 'READY');
        assert.equal(record.cleanupStatus, 'COMPLETE');
        assert.equal(Number((await db.query('SELECT count(*) FROM human_quality_assessments WHERE task_id=$1',
          [task.taskId])).rows[0].count), 0, 'the real reset must cascade-delete the live assessments');
        const archived = (await db.query(`SELECT stage,action,created_at FROM task_reassignment_assessment_records
          WHERE task_id=$1 AND assessment_id=$2`, [task.taskId, firstAssessmentId])).rows;
        assert.equal(archived.length, 1);
        assert.equal(archived[0].stage, 'COPY');
        assert.equal(archived[0].action, firstAction);
        assert.equal(archived[0].created_at.toISOString(), firstReviewAt.toISOString());
        const archivedCount = Number((await db.query(`SELECT count(*) FROM task_reassignment_assessment_records
          WHERE task_id=$1`, [task.taskId])).rows[0].count);
        assert.equal(archivedCount, 4, 'COPY SAVE and IMAGE DISCARD are also archived but must be ignored');
        await assertFirstReview(task.taskId);
        assert.equal((await reportFor(task.taskId, beijingDay(oldApprovalAt))).total, 0,
          'deleting the earlier live decision must not move the task to its later approval date');

        await repository.disposeReassignmentCase(record.id, {
          requestId: randomUUID(), expectedVersion: record.version, note: '由乙重新审核',
          targetAccountId: annotatorB.userId,
        }, { actor: admin, operation: 'REASSIGN' });
        const reassigned = await repository.getTask(task.taskId);
        assert.equal(reassigned.state, 'COPY_REVIEW_PENDING');
        assert.equal(reassigned.assignedToUserId, annotatorB.username);
        await assertFirstReview(task.taskId);
        await repository.approveCopy(task.taskId, {
          revisionId: reassigned.currentCopyRevisionId, nodeId: NODE_ID, decision: 'APPROVE',
          score: 3, originalScore: 3, reviewSessionId: randomUUID(),
        }, { actor: annotatorB });
        const row = await assertFirstReview(task.taskId);
        assert.equal(row.currentAnnotator.accountId, annotatorB.userId);
        assert.equal(row.reassignmentCount, 1);
        assert.equal((await reportFor(task.taskId, today)).total, 0,
          'approval after the secondary reassignment must not count the task again');
        assert.equal((await reportFor(task.taskId, beijingDay(firstReviewAt), today)).total, 1);
      });
    }
  } finally {
    await repository.close();
    await database.stop();
  }
});
