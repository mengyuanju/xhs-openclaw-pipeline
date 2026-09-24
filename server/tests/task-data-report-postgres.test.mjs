import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import {
  readTaskDataReport, readTaskDataReportTask, exportTaskDataReportCsv,
} from '../src/task-data-report.mjs';
import { startTemporaryPostgres18 } from './helpers/personal-postgres.mjs';

test('task data report keeps first manual assignment and separates QA verdict from batch release', {
  skip: process.env.RUN_POSTGRES_E2E !== '1', timeout: 180_000,
}, async () => {
  const database = await startTemporaryPostgres18();
  const repository = new PostgresControlPlaneRepository({ connectionString: database.connectionString });
  try {
    await repository.initialize();
    const db = repository.pool;
    await db.query("INSERT INTO executor_nodes(id,name) VALUES('report-node','Report Node')");
    const accounts = (await db.query(`INSERT INTO app_users(username,display_name,role,password_hash,status)
      VALUES('report-admin','管理员','ADMIN','test-only','ACTIVE'),
        ('report-annotator-a','标注甲','USER','test-only','ACTIVE'),
        ('report-annotator-b','标注乙','USER','test-only','ACTIVE'),
        ('report-copy-qa-a','文案质检甲','REVIEWER','test-only','ACTIVE'),
        ('report-copy-qa-b','文案质检乙','REVIEWER','test-only','ACTIVE')
      RETURNING id,username,role`)).rows;
    const [admin, annotatorA, annotatorB, qaA, qaB] = accounts.map(row => ({
      userId: Number(row.id), username: row.username, role: row.role,
    }));
    const assignedAt = new Date(Date.now() - 10 * 86_400_000);
    const assignedDay = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(assignedAt);
    async function createTask(name, selected, reviewerId = null) {
      const task = (await db.query(`INSERT INTO tasks(query,input,state,created_by_node_id,
        assigned_to_user_id,assignment_source,assigned_at)
        VALUES($1,'{}','COPY_QC_PENDING','report-node',$2,'MANUAL',$3) RETURNING id`,
      [name, annotatorA.username, assignedAt])).rows[0];
      const taskId = Number(task.id);
      await db.query(`INSERT INTO task_assignment_events(task_id,actor_username,
        previous_assignee_user_id,assignee_user_id,source,created_at)
        VALUES($1,$2,NULL,$3,'MANUAL',$4)`,
      [taskId, admin.username, annotatorA.username, new Date(assignedAt.getTime() + 1000)]);
      const revision = (await db.query(`INSERT INTO copy_revisions(task_id,revision,content,
        revision_origin,approved_at) VALUES($1,1,$2,'GENERATION',now()) RETURNING id`,
      [taskId, { copy: { title: name, body: '正文', tags: [] }, imagePlan: [] }])).rows[0];
      const revisionId = Number(revision.id);
      await db.query('UPDATE tasks SET current_copy_revision_id=$2 WHERE id=$1', [taskId, revisionId]);
      const approval = (await db.query(`INSERT INTO copy_approval_events(task_id,copy_revision_id,
        approval_mode,approved_by_account_id,approved_by_username,content_sha256)
        VALUES($1,$2,'MANUAL',$3,$4,$5) RETURNING id`,
      [taskId, revisionId, annotatorA.userId, annotatorA.username, 'a'.repeat(64)])).rows[0];
      return { taskId, revisionId, approvalId: Number(approval.id), selected, reviewerId };
    }
    const passed = await createTask('人工抽检通过', true, qaA.userId);
    const released = await createTask('=SUM(1,1)', false);
    const batch = (await db.query(`INSERT INTO copy_qa_batches_v2(mode,full_inspection,
      blind_review_enabled,sampling_rate_bps,return_threshold_bps,return_trigger_count,
      member_count,sample_count,status,created_by_account_id,completed_at)
      VALUES('MIXED_MANUAL',false,false,5000,5000,1,2,1,'COMPLETED',$1,now()) RETURNING id`,
    [admin.userId])).rows[0];
    for (const fixture of [passed, released]) {
      await db.query(`INSERT INTO copy_qa_batch_members_v2(batch_id,task_id,copy_revision_id,
        approval_event_id,approver_account_id,quality_cycle,content_sha256,selected,status,
        reviewed_by_account_id,decided_at)
        VALUES($1,$2,$3,$4,$5,0,$6,$7,$8,$9,$10)`,
      [batch.id, fixture.taskId, fixture.revisionId, fixture.approvalId,
        annotatorA.userId, 'a'.repeat(64), fixture.selected,
        fixture.selected ? 'PASSED' : 'RELEASED', fixture.reviewerId,
        fixture.selected ? new Date(Date.now() - 60_000) : null]);
      await db.query(`UPDATE tasks SET state='IMAGE_QUEUED',current_stage='IMAGE_QUEUED',
        copy_qc_released_revision_id=$2 WHERE id=$1`, [fixture.taskId, fixture.revisionId]);
    }
    const productionBatch = (await db.query(`INSERT INTO production_batches(public_id,
      query_package_name,created_by_account_id,created_by_username,request_id,request_fingerprint,
      client_batch_code)
      VALUES($1,'报表测试批次',$2,$3,$4,$5,$6) RETURNING id`,
    [randomUUID(), admin.userId, admin.username, randomUUID(), 'c'.repeat(64),
      'a'.repeat(32)])).rows[0];
    const imageFreeze = (await db.query(`INSERT INTO image_sampling_freezes(public_id,
      production_batch_id,policy_version,rate_bps,seed,algorithm_version,
      blind_review_enabled,submitter_account_id,population_count,sample_count,
      snapshot_sha256,frozen_by_account_id,frozen_by_username,request_id,close_reason,
      status,resolved_at)
      VALUES($1,$2,1,5000,'fixture','test',false,$3,2,1,$4,$5,$6,$7,'TEST',
        'RELEASED',now()) RETURNING id`,
    [randomUUID(), productionBatch.id, annotatorA.userId, 'd'.repeat(64),
      admin.userId, admin.username, randomUUID()])).rows[0];
    for (const fixture of [passed, released]) {
      const runId = randomUUID();
      await db.query(`INSERT INTO image_runs(id,task_id,copy_revision_id,status,
        image_production_chain_id) VALUES($1,$2,$3,'COMPLETED',$1)`,
      [runId, fixture.taskId, fixture.revisionId]);
      await db.query('UPDATE tasks SET current_image_run_id=$2 WHERE id=$1',
        [fixture.taskId, runId]);
      const imageApproval = (await db.query(`INSERT INTO image_approval_events(task_id,
        copy_revision_id,image_run_id,submitted_by_account_id,submitted_by_username,
        review_session_id,image_set_sha256)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [fixture.taskId, fixture.revisionId, runId, annotatorA.userId,
        annotatorA.username, randomUUID(), 'e'.repeat(64)])).rows[0];
      const item = (await db.query(`INSERT INTO image_sampling_items(public_id,freeze_id,
        task_id,approval_event_id,copy_revision_id,image_run_id,image_set_sha256,
        submitter_account_id,submitter_username,rank_hash,selected,status,
        reviewed_by_account_id,reviewed_by_username,reviewed_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [randomUUID(), imageFreeze.id, fixture.taskId, imageApproval.id,
        fixture.revisionId, runId, 'e'.repeat(64), annotatorA.userId,
        annotatorA.username, 'f'.repeat(64), fixture.selected,
        fixture.selected ? 'PASSED' : 'RELEASED',
        fixture.selected ? qaB.userId : null,
        fixture.selected ? qaB.username : null,
        fixture.selected ? new Date(Date.now() - 30_000) : null])).rows[0];
      if (fixture.selected) await db.query(`INSERT INTO image_sampling_events(freeze_id,
        sampling_item_id,action,actor_account_id,actor_username,request_id)
        VALUES($1,$2,'PASS',$3,$4,$5)`,
      [imageFreeze.id, item.id, qaB.userId, qaB.username, randomUUID()]);
      await db.query(`UPDATE tasks SET state='REVIEWED',current_stage='REVIEWED',
        image_qc_released_approval_event_id=$2,image_reviewed_at=now() WHERE id=$1`,
      [fixture.taskId, imageApproval.id]);
    }
    await db.query(`UPDATE tasks SET assigned_to_user_id=$2,assignment_source='MANUAL',assigned_at=now()
      WHERE id=$1`, [passed.taskId, annotatorB.username]);
    await db.query(`INSERT INTO task_assignment_events(task_id,actor_username,
      previous_assignee_user_id,assignee_user_id,source)
      VALUES($1,$2,$3,$4,'MANUAL')`,
    [passed.taskId, admin.username, annotatorA.username, annotatorB.username]);
    const query = { time: { field: 'FIRST_MANUAL_COPY_ASSIGNMENT', mode: 'ABSOLUTE',
      from: assignedDay, to: assignedDay }, page: 1, pageSize: 20 };
    const report = await readTaskDataReport(db, admin, query);
    assert.equal(report.total, 2);
    assert.equal(report.summary.copyQaReleased, 2);
    const byId = new Map(report.items.map(item => [item.taskId, item]));
    const passedRow = byId.get(passed.taskId);
    const releasedRow = byId.get(released.taskId);
    assert.ok(passedRow.firstManualCopyAssignmentAt);
    assert.equal(passedRow.reassignmentCount, 1);
    assert.deepEqual(passedRow.annotationPeople.map(person => person.username),
      [annotatorA.username, annotatorB.username]);
    assert.ok(passedRow.copyQaHumanPassedAt);
    assert.ok(passedRow.copyQaReleasedAt);
    assert.equal(passedRow.copyQaReleaseMode, 'HUMAN_PASS');
    assert.deepEqual(passedRow.copyQaPeople.map(person => person.accountId), [qaA.userId]);
    assert.equal(releasedRow.copyQaHumanPassedAt, null);
    assert.ok(releasedRow.copyQaReleasedAt);
    assert.equal(releasedRow.copyQaReleaseMode, 'BATCH_RELEASE');
    assert.deepEqual(releasedRow.copyQaPeople, []);
    assert.ok(passedRow.imageQaHumanPassedAt);
    assert.ok(passedRow.imageQaReleasedAt);
    assert.equal(passedRow.imageQaReleaseMode, 'HUMAN_PASS');
    assert.deepEqual(passedRow.imageQaPeople.map(person => person.accountId), [qaB.userId]);
    assert.equal(releasedRow.imageQaHumanPassedAt, null);
    assert.ok(releasedRow.imageQaReleasedAt);
    assert.equal(releasedRow.imageQaReleaseMode, 'BATCH_RELEASE');
    assert.deepEqual(releasedRow.imageQaPeople, []);
    const qaAResult = await readTaskDataReport(db, admin, {
      ...query, conditions: [{ field: 'COPY_QA_REVIEWER', op: 'EQ', value: qaA.userId }],
    });
    assert.deepEqual(qaAResult.items.map(item => item.taskId), [passed.taskId]);
    const qaBResult = await readTaskDataReport(db, admin, {
      ...query, conditions: [{ field: 'COPY_QA_REVIEWER', op: 'EQ', value: qaB.userId }],
    });
    assert.equal(qaBResult.total, 0);
    const imageQaResult = await readTaskDataReport(db, admin, {
      ...query, conditions: [{ field: 'IMAGE_QA_REVIEWER', op: 'EQ', value: qaB.userId }],
    });
    assert.deepEqual(imageQaResult.items.map(item => item.taskId), [passed.taskId]);
    const detail = await readTaskDataReportTask(db, admin, passed.taskId);
    assert.equal(detail.item.taskId, passed.taskId);
    assert.ok(detail.events.some(event => event.kind === 'ASSIGNMENT'));
    const csv = await exportTaskDataReportCsv(db, admin, query);
    assert.match(csv, /人工抽检通过/u);
    assert.match(csv, /"'=SUM\(1,1\)"/u);
    assert.match(csv, /文案质检放行时间（北京时间）/u);
    assert.equal(csv.split('\r\n').filter(Boolean).length, 3); // Header and two task rows.
    await assert.rejects(readTaskDataReport(db, { ...admin, role: 'USER' }, query),
      /仅管理员/u);
  } finally {
    await repository.close();
    await database.stop();
  }
});
