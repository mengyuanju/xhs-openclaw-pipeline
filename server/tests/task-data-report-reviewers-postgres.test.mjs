import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { readTaskDataReport } from '../src/task-data-report.mjs';
import { startTemporaryPostgres18 } from './helpers/personal-postgres.mjs';

test('task report preserves reviewers for individual and batch QA decisions', {
  skip: process.env.RUN_POSTGRES_E2E !== '1', timeout: 180_000,
}, async (t) => {
  const database = await startTemporaryPostgres18();
  const repository = new PostgresControlPlaneRepository({ connectionString: database.connectionString });
  try {
    await repository.initialize();
    const db = repository.pool;
    await db.query("INSERT INTO executor_nodes(id,name) VALUES('report-reviewers-node','Report Reviewers')");
    const accounts = (await db.query(`INSERT INTO app_users(
      username,display_name,role,password_hash,status,copy_qc_enabled,image_qc_enabled)
      VALUES('reviewer-report-admin','管理员','ADMIN','test-only','ACTIVE',true,true),
        ('reviewer-report-annotator','标注人','USER','test-only','ACTIVE',false,false),
        ('reviewer-report-qa-a','质检甲','REVIEWER','test-only','ACTIVE',true,true),
        ('reviewer-report-qa-b','质检乙','REVIEWER','test-only','ACTIVE',true,true)
      RETURNING id,username,role,credential_version`)).rows;
    const [admin, annotator, qaA, qaB] = accounts.map(row => ({
      userId: Number(row.id), username: row.username, role: row.role,
      credentialVersion: Number(row.credential_version),
    }));
    const contentHash = 'a'.repeat(64);
    const content = { copy: { title: '报表质检人回归', body: '正文', tags: [] }, imagePlan: [] };

    async function createTask(name) {
      const task = (await db.query(`INSERT INTO tasks(query,input,state,created_by_node_id,
        assigned_to_user_id,assignment_source,assigned_at,created_at)
        VALUES($1,'{}','COPY_QC_PENDING','report-reviewers-node',$2,'MANUAL',now(),
          '2026-01-02T04:00:00Z') RETURNING id`, [name, annotator.username])).rows[0];
      const taskId = Number(task.id);
      const revision = (await db.query(`INSERT INTO copy_revisions(task_id,revision,content,
        revision_origin,approved_at,approval_mode)
        VALUES($1,1,$2,'GENERATION',now(),'MANUAL') RETURNING id`, [taskId, content])).rows[0];
      const revisionId = Number(revision.id);
      await db.query('UPDATE tasks SET current_copy_revision_id=$2 WHERE id=$1', [taskId, revisionId]);
      const approval = (await db.query(`INSERT INTO copy_approval_events(task_id,copy_revision_id,
        approval_mode,approved_by_account_id,approved_by_username,content_sha256)
        VALUES($1,$2,'MANUAL',$3,$4,$5) RETURNING id`,
      [taskId, revisionId, annotator.userId, annotator.username, contentHash])).rows[0];
      return { taskId, revisionId, approvalId: Number(approval.id) };
    }

    async function copyRework(task) {
      const draft = (await db.query(`INSERT INTO copy_revisions(task_id,revision,content,
        parent_revision_id,revision_origin)
        VALUES($1,2,$2,$3,'QA_RETURN') RETURNING id`,
      [task.taskId, content, task.revisionId])).rows[0];
      await db.query(`UPDATE tasks SET state='COPY_REVIEW_PENDING',
        current_stage='COPY_REVIEW_PENDING',current_copy_revision_id=$2,
        copy_qc_released_revision_id=NULL,copy_qa_rework_pending=true WHERE id=$1`,
      [task.taskId, draft.id]);
    }

    async function createV2Batch(memberCount, sampleCount, status) {
      return Number((await db.query(`INSERT INTO copy_qa_batches_v2(mode,full_inspection,
        blind_review_enabled,sampling_rate_bps,return_threshold_bps,return_trigger_count,
        member_count,sample_count,status,created_by_account_id,completed_at)
        VALUES('MIXED_MANUAL',false,false,5000,5000,1,$1,$2,$3,$4,now()) RETURNING id`,
      [memberCount, sampleCount, status, admin.userId])).rows[0].id);
    }

    async function createV2Member(batchId, task, status, selected, reviewer) {
      return Number((await db.query(`INSERT INTO copy_qa_batch_members_v2(batch_id,task_id,
        copy_revision_id,approval_event_id,approver_account_id,quality_cycle,
        content_sha256,selected,status,reviewed_by_account_id,decided_at)
        VALUES($1,$2,$3,$4,$5,0,$6,$7,$8,$9,CASE WHEN $9::bigint IS NULL THEN NULL ELSE now() END)
        RETURNING id`, [batchId, task.taskId, task.revisionId, task.approvalId,
        annotator.userId, contentHash, selected, status, reviewer?.userId ?? null])).rows[0].id);
    }

    async function reportFor(task, field = null, reviewer = null) {
      const conditions = [{ field: 'TASK_ID', op: 'EQ', value: task.taskId }];
      if (field) conditions.push({ field, op: 'EQ', value: reviewer.userId });
      return readTaskDataReport(db, admin, {
        time: { field: 'CREATED_AT', mode: 'ABSOLUTE', from: '2026-01-02', to: '2026-01-02' },
        conditions, sort: 'TASK_ID',
      });
    }

    async function assertReviewer(task, stage, reviewer, otherReviewer, rejectionCount = null) {
      const report = await reportFor(task);
      assert.equal(report.items.length, 1, 'task is present without a reviewer filter');
      const row = report.items[0];
      const people = stage === 'COPY' ? row.copyQaPeople : row.imageQaPeople;
      assert.deepEqual(people.map(person => person.accountId), [reviewer.userId]);
      assert.equal(people[0].username, reviewer.username);
      if (rejectionCount !== null) assert.equal(row.rejectionCount, rejectionCount);
      const field = stage === 'COPY' ? 'COPY_QA_REVIEWER' : 'IMAGE_QA_REVIEWER';
      assert.deepEqual((await reportFor(task, field, reviewer)).items.map(item => item.taskId),
        [task.taskId], 'reviewer filter agrees with the displayed reviewer');
      assert.equal((await reportFor(task, field, otherReviewer)).items.length, 0,
        'a different reviewer does not match');
    }

    const direct = await createTask('文案直接驳回');
    const affected = await createTask('文案整批关联驳回');
    const returnBatchId = await createV2Batch(2, 1, 'AUTO_RETURNED');
    for (const [task, status, selected, kind] of [
      [direct, 'RETURNED', true, 'DIRECT'], [affected, 'BATCH_AFFECTED', false, 'BATCH_AFFECTED'],
    ]) {
      const memberId = await createV2Member(returnBatchId, task, status, selected, qaA);
      await db.query(`INSERT INTO copy_qa_return_events_v2(task_id,quality_cycle,member_id,kind)
        VALUES($1,0,$2,$3)`, [task.taskId, memberId, kind]);
      await copyRework(task);
    }

    const discarded = await createTask('文案质检废弃');
    const discardBatchId = await createV2Batch(1, 1, 'COMPLETED');
    const discardedMemberId = await createV2Member(discardBatchId, discarded, 'DISCARDED', true, qaB);
    await db.query(`INSERT INTO copy_qa_dispositions_v2(member_id,task_id,copy_revision_id,
      reason_code,note,actor_account_id,actor_username,request_id)
      VALUES($1,$2,$3,'OTHER','人工质检废弃',$4,$5,$6)`,
    [discardedMemberId, discarded.taskId, discarded.revisionId, qaB.userId, qaB.username, randomUUID()]);
    await db.query(`UPDATE tasks SET state='CANCELLED',current_stage='CANCELLED',
      cancelled_from_state='COPY_QC_PENDING',finished_at=now() WHERE id=$1`, [discarded.taskId]);

    const released = await createTask('文案未抽中放行');
    const releasedBatchId = await createV2Batch(1, 0, 'COMPLETED');
    await createV2Member(releasedBatchId, released, 'RELEASED', false, null);
    await db.query(`UPDATE tasks SET state='IMAGE_QUEUED',current_stage='IMAGE_QUEUED',
      copy_qc_released_revision_id=$2 WHERE id=$1`, [released.taskId, released.revisionId]);

    async function productionBatch(name) {
      return Number((await db.query(`INSERT INTO production_batches(public_id,query_package_name,
        created_by_account_id,created_by_username,request_id,request_fingerprint,client_batch_code)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [randomUUID(), name, admin.userId, admin.username, randomUUID(), contentHash,
        randomUUID().replaceAll('-', '')])).rows[0].id);
    }

    const legacyTask = await createTask('历史文案整批关联驳回');
    const legacyBatchId = await productionBatch('历史文案返修批次');
    const legacyFreezeId = Number((await db.query(`INSERT INTO copy_sampling_freezes(public_id,
      production_batch_id,policy_version,rate_bps,seed,algorithm_version,blind_review_enabled,
      population_count,sample_count,snapshot_sha256,frozen_by_account_id,frozen_by_username,
      request_id,request_fingerprint,status,resolved_at)
      VALUES($1,$2,1,5000,'fixture','test',false,1,0,$3,$4,$5,$6,$3,'BATCH_RETURNED',now())
      RETURNING id`, [randomUUID(), legacyBatchId, contentHash, admin.userId,
      admin.username, randomUUID()])).rows[0].id);
    const legacyItemId = Number((await db.query(`INSERT INTO copy_sampling_items(public_id,
      freeze_id,task_id,approval_event_id,copy_revision_id,content_sha256,
      final_approver_account_id,final_approver_username,rank_hash,selected,status,
      reviewed_by_account_id,reviewed_by_username,reviewed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$6,false,'BATCH_AFFECTED',$9,$10,NULL) RETURNING id`,
    [randomUUID(), legacyFreezeId, legacyTask.taskId, legacyTask.approvalId,
      legacyTask.revisionId, contentHash, annotator.userId, annotator.username,
      qaA.userId, qaA.username])).rows[0].id);
    await db.query(`INSERT INTO copy_qa_return_events_v2(task_id,quality_cycle,legacy_item_id,kind)
      VALUES($1,0,$2,'BATCH_AFFECTED')`, [legacyTask.taskId, legacyItemId]);
    await copyRework(legacyTask);

    const imageAffected = await createTask('图片未抽中但整批返修');
    const imageHistorical = await createTask('图片整批返修旧项已替换');
    const imageUnaffected = await createTask('图片同批次但未被返修');
    const imageBatchId = await productionBatch('图片批次返修');
    const imageFreezeId = Number((await db.query(`INSERT INTO image_sampling_freezes(public_id,
      production_batch_id,policy_version,rate_bps,seed,algorithm_version,blind_review_enabled,
      submitter_account_id,population_count,sample_count,snapshot_sha256,frozen_by_account_id,
      frozen_by_username,request_id,close_reason,status,resolved_at)
      VALUES($1,$2,1,5000,'fixture','test',false,$3,3,0,$4,$5,$6,$7,'TEST','BATCH_RETURNED',now())
      RETURNING id`, [randomUUID(), imageBatchId, annotator.userId, contentHash,
      admin.userId, admin.username, randomUUID()])).rows[0].id);

    async function imageItem(task, status, reviewer) {
      const runId = randomUUID();
      await db.query(`INSERT INTO image_runs(id,task_id,copy_revision_id,status,image_production_chain_id)
        VALUES($1,$2,$3,'COMPLETED',$1)`, [runId, task.taskId, task.revisionId]);
      const approvalId = Number((await db.query(`INSERT INTO image_approval_events(task_id,
        copy_revision_id,image_run_id,submitted_by_account_id,submitted_by_username,
        review_session_id,image_set_sha256)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [task.taskId, task.revisionId,
        runId, annotator.userId, annotator.username, randomUUID(), contentHash])).rows[0].id);
      await db.query(`UPDATE tasks SET state='IMAGE_REWORK_PENDING',current_stage='IMAGE_REWORK_PENDING',
        current_image_run_id=$2,copy_qc_released_revision_id=$3 WHERE id=$1`,
      [task.taskId, runId, task.revisionId]);
      return Number((await db.query(`INSERT INTO image_sampling_items(public_id,freeze_id,
        task_id,approval_event_id,copy_revision_id,image_run_id,image_set_sha256,
        submitter_account_id,submitter_username,rank_hash,selected,status,
        reviewed_by_account_id,reviewed_by_username,reviewed_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$7,false,$10,$11,$12,
          CASE WHEN $11::bigint IS NULL THEN NULL ELSE now() END) RETURNING id`,
      [randomUUID(), imageFreezeId, task.taskId, approvalId, task.revisionId, runId,
        contentHash, annotator.userId, annotator.username, status,
        reviewer?.userId ?? null, reviewer?.username ?? null])).rows[0].id);
    }

    await imageItem(imageAffected, 'BATCH_RETURNED', qaA);
    const historicalImageItemId = await imageItem(imageHistorical, 'BATCH_RETURNED', qaA);
    await imageItem(imageUnaffected, 'RELEASED', null);
    await db.query(`INSERT INTO image_sampling_events(freeze_id,action,actor_account_id,
      actor_username,request_id,details)
      VALUES($1,'RETURN_BATCH',$2,$3,$4,$5)`, [imageFreezeId, qaA.userId, qaA.username,
      randomUUID(), { affectedTaskIds: [imageAffected.taskId, imageHistorical.taskId], affectedCount: 2 }]);
    await db.query("UPDATE image_sampling_items SET status='SUPERSEDED' WHERE id=$1",
      [historicalImageItemId]);

    await t.test('direct copy return displays and filters its reviewer', async () => {
      await assertReviewer(direct, 'COPY', qaA, qaB, 1);
    });
    await t.test('batch affected copy return displays the triggering reviewer', async () => {
      await assertReviewer(affected, 'COPY', qaA, qaB, 1);
    });
    await t.test('legacy batch affected copy item may have no reviewed_at', async () => {
      await assertReviewer(legacyTask, 'COPY', qaA, qaB, 1);
    });
    await t.test('copy QA discard retains the actual reviewer', async () => {
      await assertReviewer(discarded, 'COPY', qaB, qaA, 0);
    });
    await t.test('unsampled copy release does not invent a reviewer', async () => {
      assert.deepEqual((await reportFor(released)).items[0].copyQaPeople, []);
      assert.equal((await reportFor(released, 'COPY_QA_REVIEWER', qaA)).items.length, 0);
      assert.equal((await reportFor(released, 'COPY_QA_REVIEWER', qaB)).items.length, 0);
    });
    await t.test('image batch return includes an unsampled affected item', async () => {
      await assertReviewer(imageAffected, 'IMAGE', qaA, qaB);
    });
    await t.test('superseded image item keeps the historical batch reviewer', async () => {
      await assertReviewer(imageHistorical, 'IMAGE', qaA, qaB);
    });
    await t.test('image batch actor does not leak to a task outside affectedTaskIds', async () => {
      assert.deepEqual((await reportFor(imageUnaffected)).items[0].imageQaPeople, []);
      assert.equal((await reportFor(imageUnaffected, 'IMAGE_QA_REVIEWER', qaA)).items.length, 0);
      assert.equal((await reportFor(imageUnaffected, 'IMAGE_QA_REVIEWER', qaB)).items.length, 0);
    });
  } finally {
    await repository.close();
    await database.stop();
  }
});
