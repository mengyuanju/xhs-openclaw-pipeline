import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import {
  readTaskDataReport, readTaskDataReportTask, exportTaskDataReportCsv,
} from '../src/task-data-report.mjs';
import { startTemporaryPostgres18 } from './helpers/personal-postgres.mjs';

test('task data report dates tasks by first review, discard or bypass and keeps QA counts', {
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
      RETURNING id,username,role,credential_version`)).rows;
    const [admin, annotatorA, annotatorB, qaA, qaB] = accounts.map(row => ({
      userId: Number(row.id), username: row.username, role: row.role,
      credentialVersion: Number(row.credential_version),
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
    const pendingQuery = { time: { field: 'FIRST_COPY_ASSIGNMENT', mode: 'ABSOLUTE',
      from: assignedDay, to: assignedDay } };
    let pendingReport = await readTaskDataReport(db, admin, pendingQuery);
    assert.equal(pendingReport.summary.qaPending, 2);
    assert.equal(pendingReport.summary.copyQaPending, 2);
    assert.equal(pendingReport.summary.imageQaPending, 0);
    assert.equal(pendingReport.summary.reviewPending, 0);
    await db.query("UPDATE tasks SET state='IMAGE_QC_PENDING',current_stage='IMAGE_QC_PENDING' WHERE id=$1",
      [released.taskId]);
    pendingReport = await readTaskDataReport(db, admin, pendingQuery);
    assert.equal(pendingReport.summary.qaPending, 2);
    assert.equal(pendingReport.summary.copyQaPending, 1);
    assert.equal(pendingReport.summary.imageQaPending, 1);
    await db.query("UPDATE tasks SET state='COPY_REVIEW_PENDING',current_stage='COPY_REVIEW_PENDING' WHERE id=$1",
      [passed.taskId]);
    await db.query("UPDATE tasks SET state='MANUAL_ARCHIVE',current_stage='MANUAL_ARCHIVE' WHERE id=$1",
      [released.taskId]);
    let reviewReport = await readTaskDataReport(db, admin, pendingQuery);
    assert.equal(reviewReport.summary.reviewPending, 2);
    assert.equal(reviewReport.summary.copyReviewPending, 1);
    assert.equal(reviewReport.summary.copyInitialReviewPending, 1);
    assert.equal(reviewReport.summary.copyReworkPending, 0,
      'a reviewed pending task without an active QA return does not need COPY rework');
    assert.equal(reviewReport.summary.imageReviewPending, 1);
    await db.query("UPDATE tasks SET state='PENDING_SECOND_ASSIGNMENT',current_stage='PENDING_SECOND_ASSIGNMENT' WHERE id=$1",
      [passed.taskId]);
    await db.query("UPDATE tasks SET state='IMAGE_REWORK_PENDING',current_stage='IMAGE_REWORK_PENDING' WHERE id=$1",
      [released.taskId]);
    reviewReport = await readTaskDataReport(db, admin, pendingQuery);
    assert.equal(reviewReport.summary.reviewPending, 1);
    assert.equal(reviewReport.summary.copyReviewPending, 0,
      'PENDING_SECOND_ASSIGNMENT is distinct from assigned COPY review work');
    assert.equal(reviewReport.summary.copyInitialReviewPending, 0);
    assert.equal(reviewReport.summary.copyReworkPending, 0);
    assert.equal(reviewReport.summary.imageReviewPending, 1);
    await db.query("UPDATE tasks SET state='COPY_QC_PENDING',current_stage='COPY_QC_PENDING' WHERE id=$1",
      [passed.taskId]);
    await db.query("UPDATE tasks SET state='COPY_QC_PENDING',current_stage='COPY_QC_PENDING' WHERE id=$1",
      [released.taskId]);
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
      await db.query(`INSERT INTO delivery_entries(
        task_id,copy_revision_id,image_run_id,approved_by_account_id,approved_by_username)
        VALUES($1,$2,$3,$4,$5)`,
      [fixture.taskId, fixture.revisionId, runId, qaB.userId, qaB.username]);
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
    assert.equal(report.summary.copyQaPassed, 2);
    assert.equal(report.summary.copyQaFirstPassed, 2,
      'first-time human PASS and completed unsampled RELEASED both count once');
    assert.equal(report.summary.imageQaPassed, 2);
    assert.equal(report.summary.reviewPending, 0);
    assert.equal(report.summary.copyReviewPending, 0);
    assert.equal(report.summary.copyInitialReviewPending, 0);
    assert.equal(report.summary.copyReworkPending, 0);
    assert.equal(report.summary.imageReviewPending, 0);
    assert.equal(report.summary.qaPending, 0);
    assert.equal(report.summary.copyQaPending, 0);
    assert.equal(report.summary.imageQaPending, 0);
    assert.equal(report.summary.discarded, 0);
    assert.equal(report.summary.packingDelivery, 2);
    assert.deepEqual(report.overview, { unpacked: 0, packed: 0, delivered: 0 },
      'the assignment-day detail cohort differs from today\'s delivery-ready operations');
    assert.ok(report.summary.copyQaPassed >= report.summary.packingDelivery);
    assert.ok(report.summary.imageQaPassed >= report.summary.packingDelivery);
    const firstAssignmentReport = await readTaskDataReport(db, admin, {
      time: { field: 'FIRST_COPY_ASSIGNMENT', mode: 'ABSOLUTE',
        from: assignedDay, to: assignedDay },
      sort: 'FIRST_COPY_ASSIGNMENT',
    });
    assert.equal(firstAssignmentReport.total, 2);
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
    const idSearch = await readTaskDataReport(db, admin, {
      ...query, conditions: [
        { field: 'TASK_ID_OR_NAME', op: 'CONTAINS', value: `#${passed.taskId}` },
        { field: 'STATE', op: 'EQ', value: 'REVIEWED' },
        { field: 'REASSIGNMENT_COUNT', op: 'GTE', value: 1 },
        { field: 'COPY_QA_REVIEWER', op: 'EQ', value: qaA.userId },
        { field: 'IMAGE_QA_REVIEWER', op: 'EQ', value: qaB.userId },
      ],
    });
    assert.deepEqual(idSearch.items.map(item => item.taskId), [passed.taskId]);
    const nameSearch = await readTaskDataReport(db, admin, {
      ...query, conditions: [{ field: 'TASK_ID_OR_NAME', op: 'CONTAINS', value: '人工抽检' }],
    });
    assert.deepEqual(nameSearch.items.map(item => item.taskId), [passed.taskId]);
    const bareNumber = await readTaskDataReport(db, admin, {
      ...query, conditions: [{ field: 'TASK_ID_OR_NAME', op: 'CONTAINS', value: String(passed.taskId) }],
    });
    assert.equal(bareNumber.items.some(item => item.taskId === passed.taskId), false);
    const literalPercent = await readTaskDataReport(db, admin, {
      ...query, conditions: [{ field: 'TASK_ID_OR_NAME', op: 'CONTAINS', value: '%' }],
    });
    assert.equal(literalPercent.total, 0);
    const detail = await readTaskDataReportTask(db, admin, passed.taskId);
    assert.equal(detail.item.taskId, passed.taskId);
    assert.ok(detail.events.some(event => event.kind === 'ASSIGNMENT'));
    const csv = await exportTaskDataReportCsv(db, admin, query);
    assert.match(csv, /人工抽检通过/u);
    assert.match(csv, /"'=SUM\(1,1\)"/u);
    assert.match(csv, /文案质检放行时间（北京时间）/u);
    assert.equal(csv.split('\r\n').filter(Boolean).length, 3); // Header and two task rows.
    const todayDay = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    const yesterdayAt = new Date(new Date(`${todayDay}T00:00:00+08:00`).getTime() - 12 * 3_600_000);
    const yesterdayDay = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(yesterdayAt);
    const reviewedYesterday = await createTask('先审核后通过', false);
    await db.query('UPDATE tasks SET created_at=$2 WHERE id=$1',
      [reviewedYesterday.taskId, new Date(yesterdayAt.getTime() - 86_400_000)]);
    const reviewSessionId = randomUUID();
    const fingerprint = 'f'.repeat(64);
    await db.query(`INSERT INTO human_quality_review_submissions(
      review_session_id,task_id,stage,reviewer_username,request_fingerprint)
      VALUES($1,$2,'COPY',$3,$4)`,
    [reviewSessionId, reviewedYesterday.taskId, annotatorA.username, fingerprint]);
    await db.query(`INSERT INTO human_quality_assessments(
      task_id,stage,copy_revision_id,score_x10,rating_context,action,
      reviewer_username,review_session_id,request_fingerprint,created_at)
      VALUES($1,'COPY',$2,20,'ORIGINAL','RETRY',$3,$4,$5,$6)`,
    [reviewedYesterday.taskId, reviewedYesterday.revisionId, annotatorA.username,
      reviewSessionId, fingerprint, yesterdayAt]);

    async function createUnreviewedTask(name, state, progressMessage = null,
      cancelledFromState = 'COPY_REVIEW_PENDING') {
      return (await db.query(`INSERT INTO tasks(query,input,state,created_by_node_id,
        assigned_to_user_id,assignment_source,assigned_at,cancelled_from_state,
        progress_message,finished_at)
        VALUES($1,'{}',$2::text,'report-node',$3,'MANUAL',now(),
          CASE WHEN $2::text='CANCELLED' THEN $5::text ELSE NULL END,
          COALESCE($4,''),CASE WHEN $2::text='CANCELLED' THEN now() ELSE NULL END)
        RETURNING id,finished_at`,
      [name, state, annotatorA.username, progressMessage, cancelledFromState])).rows[0];
    }
    const bypassed = await createTask('管理员跳过审核', false);
    await db.query('DELETE FROM copy_approval_events WHERE id=$1', [bypassed.approvalId]);
    await db.query("UPDATE copy_revisions SET approval_mode='ADMIN_BYPASS' WHERE id=$1",
      [bypassed.revisionId]);
    const directlyDiscarded = await createUnreviewedTask(
      '文案审核直接废弃', 'CANCELLED', '文案已被质检废弃');
    const generallyCancelled = await createUnreviewedTask(
      '通用废弃', 'CANCELLED', '任务已被人工废弃', 'COPY_QUEUED');
    const restoredAfterDiscard = await createUnreviewedTask(
      '废弃后恢复', 'CANCELLED', '排队任务已废弃，可由管理员重新加入队列', 'COPY_QUEUED');
    await repository.requeueCancelledTask(Number(restoredAfterDiscard.id));
    const waitingForReview = await createUnreviewedTask('仍待文案审核', 'COPY_REVIEW_PENDING');
    const todayReport = await readTaskDataReport(db, admin, {}, { now: new Date() });
    assert.equal(todayReport.total, 5);
    assert.equal(todayReport.summary.discarded, 2);
    assert.equal(todayReport.summary.packingDelivery, 2);
    assert.deepEqual(todayReport.overview, { unpacked: 2, packed: 0, delivered: 0 });
    assert.deepEqual(new Set(todayReport.items.map(item => item.taskId)),
      new Set([passed.taskId, released.taskId, bypassed.taskId,
        Number(directlyDiscarded.id), Number(generallyCancelled.id)]));
    assert.equal(todayReport.items.find(item => item.taskId === Number(directlyDiscarded.id))
      .firstCopyReviewAt, directlyDiscarded.finished_at.toISOString());
    const genericRow = todayReport.items.find(item => item.taskId === Number(generallyCancelled.id));
    assert.equal(genericRow.firstCopyReviewAt, null);
    assert.ok(genericRow.reportAt);
    const bypassRow = todayReport.items.find(item => item.taskId === bypassed.taskId);
    assert.equal(bypassRow.firstCopyReviewAt, null);
    assert.ok(bypassRow.reportAt);
    assert.equal(todayReport.items.some(item => item.taskId === Number(restoredAfterDiscard.id)), false);
    assert.equal(todayReport.items.some(item => item.taskId === Number(waitingForReview.id)), false);
    const yesterdayReport = await readTaskDataReport(db, admin, {
      time: { field: 'FIRST_COPY_REVIEW_ACTION', mode: 'ABSOLUTE',
        from: yesterdayDay, to: yesterdayDay },
    });
    assert.deepEqual(yesterdayReport.items.map(item => item.taskId), [reviewedYesterday.taskId]);
    assert.equal(yesterdayReport.items[0].firstCopyReviewAt, yesterdayAt.toISOString());
    const restoredTaskId = Number(restoredAfterDiscard.id);
    const restoredRevision = (await db.query(`INSERT INTO copy_revisions(
      task_id,revision,content,revision_origin,approved_at,approval_mode)
      VALUES($1,1,$2,'GENERATION',now(),'MANUAL') RETURNING id`,
    [restoredTaskId, { copy: { title: '恢复后审核', body: '正文', tags: [] }, imagePlan: [] }])).rows[0];
    await db.query(`UPDATE tasks SET state='COPY_QC_PENDING',current_stage='COPY_QC_PENDING',
      current_copy_revision_id=$2 WHERE id=$1`, [restoredTaskId, restoredRevision.id]);
    await db.query(`INSERT INTO copy_approval_events(task_id,copy_revision_id,
      approval_mode,approved_by_account_id,approved_by_username,content_sha256)
      VALUES($1,$2,'MANUAL',$3,$4,$5)`,
    [restoredTaskId, restoredRevision.id, annotatorA.userId, annotatorA.username, 'a'.repeat(64)]);
    const afterRestoredReview = await readTaskDataReport(db, admin, {}, { now: new Date() });
    assert.equal(afterRestoredReview.total, 6);
    const reviewedRestoredRow = afterRestoredReview.items.find(item => item.taskId === restoredTaskId);
    assert.ok(reviewedRestoredRow.firstCopyReviewAt);
    assert.equal(reviewedRestoredRow.reportAt, reviewedRestoredRow.firstCopyReviewAt);
    const reviewedBeforeDiscard = await createTask('审核后废弃并恢复', false);
    await db.query("UPDATE tasks SET state='COPY_REVIEW_PENDING',current_stage='COPY_REVIEW_PENDING' WHERE id=$1",
      [reviewedBeforeDiscard.taskId]);
    const cancelledAfterReview = await repository.cancelTask(reviewedBeforeDiscard.taskId,
      { actor: admin });
    await repository.restoreCancelledTask(reviewedBeforeDiscard.taskId,
      { expectedUpdatedAt: cancelledAfterReview.updatedAt.toISOString() }, { actor: admin });
    const restoredWithPriorReview = await readTaskDataReport(db, admin, {}, { now: new Date() });
    assert.equal(restoredWithPriorReview.total, 7);
    const priorReviewRow = restoredWithPriorReview.items.find(
      item => item.taskId === reviewedBeforeDiscard.taskId);
    assert.ok(priorReviewRow.firstCopyReviewAt);
    assert.equal(priorReviewRow.reportAt, priorReviewRow.firstCopyReviewAt);
    async function deliveryCandidate(name, { testRun = false, entryStatus = 'READY',
      hasEntry = true, qaAccepted = true } = {}) {
      const fixture = await createTask('资格回归 ' + name, false);
      const imageRunId = randomUUID();
      await db.query(`INSERT INTO image_runs(
        id,task_id,copy_revision_id,status,image_production_chain_id)
        VALUES($1,$2,$3,'COMPLETED',$1)`, [imageRunId, fixture.taskId, fixture.revisionId]);
      await db.query(`UPDATE tasks SET input=$2,current_image_run_id=$3,
        state='REVIEWED',current_stage='REVIEWED' WHERE id=$1`,
      [fixture.taskId, { testRun }, imageRunId]);
      await db.query('UPDATE tasks SET image_qc_legacy_accepted=$2 WHERE id=$1',
        [fixture.taskId, qaAccepted]);
      if (hasEntry) await db.query(`INSERT INTO delivery_entries(task_id,copy_revision_id,
        image_run_id,status,approved_by_account_id,approved_by_username,withdrawn_at)
        VALUES($1,$2,$3,$4::varchar,$5,$6,CASE WHEN $4::varchar='WITHDRAWN' THEN now() END)`,
      [fixture.taskId, fixture.revisionId, imageRunId, entryStatus, qaB.userId, qaB.username]);
      return { ...fixture, imageRunId };
    }

    const invalidWithdrawn = await deliveryCandidate('非测试已撤回', { entryStatus: 'WITHDRAWN' });
    const invalidCopy = await deliveryCandidate('非测试文案版本变化');
    const changedCopyRevisionId = Number((await db.query(`INSERT INTO copy_revisions(
      task_id,revision,content,approved_at,approval_mode)
      VALUES($1,2,'{}',now(),'MANUAL') RETURNING id`, [invalidCopy.taskId])).rows[0].id);
    await db.query('UPDATE tasks SET current_copy_revision_id=$2 WHERE id=$1',
      [invalidCopy.taskId, changedCopyRevisionId]);
    const invalidImage = await deliveryCandidate('非测试图片版本变化');
    const changedImageRunId = randomUUID();
    await db.query(`INSERT INTO image_runs(id,task_id,copy_revision_id,status,image_production_chain_id)
      VALUES($1,$2,$3,'COMPLETED',$1)`, [changedImageRunId, invalidImage.taskId, invalidImage.revisionId]);
    await db.query('UPDATE tasks SET current_image_run_id=$2 WHERE id=$1',
      [invalidImage.taskId, changedImageRunId]);
    await db.query('UPDATE tasks SET image_qc_legacy_accepted=true WHERE id=$1', [invalidImage.taskId]);
    const invalidQa = await deliveryCandidate('非测试尚未图片质检放行', { qaAccepted: false });
    const invalidNoEntry = await deliveryCandidate('非测试没有READY入口', { hasEntry: false });
    const normalPending = await createTask('资格回归 正常待文案审核', false);
    await db.query("UPDATE tasks SET state='COPY_REVIEW_PENDING',current_stage='COPY_REVIEW_PENDING' WHERE id=$1",
      [normalPending.taskId]);
    const normalImageFailed = await createTask('资格回归 正常图片生成失败待重试', false);
    const failedImageRunId = randomUUID();
    await db.query(`INSERT INTO image_runs(id,task_id,copy_revision_id,status,image_production_chain_id,finished_at)
      VALUES($1,$2,$3,'FAILED',$1,now())`,
    [failedImageRunId, normalImageFailed.taskId, normalImageFailed.revisionId]);
    await db.query(`UPDATE tasks SET state='IMAGE_FAILED',current_stage='IMAGE_FAILED',
      current_image_run_id=$2,copy_qc_released_revision_id=$3 WHERE id=$1`,
    [normalImageFailed.taskId, failedImageRunId, normalImageFailed.revisionId]);
    const normalDiscarded = await createTask('资格回归 正常废弃', false);
    await db.query(`UPDATE tasks SET state='CANCELLED',cancelled_from_state='COPY_REVIEW_PENDING',
      finished_at=now(),progress_message='任务已被人工废弃' WHERE id=$1`, [normalDiscarded.taskId]);
    await deliveryCandidate('测试 #264 已撤回但状态REVIEWED', { testRun: true, entryStatus: 'WITHDRAWN' });
    await deliveryCandidate('测试READY当前版本', { testRun: true });
    for (const [name, state] of [
      ['测试待文案质检', 'COPY_QC_PENDING'],
      ['测试待文案审核', 'COPY_REVIEW_PENDING'],
      ['测试图片生成失败', 'IMAGE_FAILED'],
      ['测试废弃', 'CANCELLED'],
    ]) {
      const fixture = await createTask('资格回归 ' + name, false);
      await db.query(`UPDATE tasks SET input='{"testRun":true}',state=$2::text,current_stage=$2::text,
        cancelled_from_state=CASE WHEN $2::text='CANCELLED' THEN 'COPY_REVIEW_PENDING' END,
        finished_at=CASE WHEN $2::text='CANCELLED' THEN now() END WHERE id=$1`,
      [fixture.taskId, state]);
    }
    const eligibilityQuery = {
      time: { field: 'FIRST_COPY_REVIEW_ACTION', mode: 'ABSOLUTE', from: todayDay, to: todayDay },
      conditions: [{ field: 'TASK_ID_OR_NAME', op: 'CONTAINS', value: '资格回归' }],
    };
    const eligibilityReport = await readTaskDataReport(db, admin, eligibilityQuery);
    const retainedIds = [invalidWithdrawn, invalidCopy, invalidImage, invalidQa, invalidNoEntry,
      normalPending, normalImageFailed, normalDiscarded].map(fixture => fixture.taskId);
    assert.equal(eligibilityReport.total, 8);
    assert.deepEqual(new Set(eligibilityReport.items.map(item => item.taskId)), new Set(retainedIds),
      'ordinary tasks remain in details even when they cannot enter the current delivery pool');
    assert.equal(eligibilityReport.summary.packingDelivery, 0,
      'REVIEWED alone is insufficient without a matching READY version and the image QA gate');
    assert.equal(eligibilityReport.summary.reviewPending, 1);
    assert.equal(eligibilityReport.summary.copyReviewPending, 1);
    assert.equal(eligibilityReport.summary.copyInitialReviewPending, 1);
    assert.equal(eligibilityReport.summary.byState.IMAGE_FAILED, 1,
      'a real failed image run remains visible for the retry card while testRun failures are excluded');
    assert.equal(eligibilityReport.summary.copyReworkPending, 0);
    assert.equal(eligibilityReport.summary.discarded, 1);
    assert.equal(eligibilityReport.summary.qaPending, 0);
    assert.equal(eligibilityReport.summary.copyQaPassed, 6);
    assert.equal(eligibilityReport.summary.imageQaPassed, 5);
    const eligibilityCsv = await exportTaskDataReportCsv(db, admin, eligibilityQuery);
    assert.equal(eligibilityCsv.split('\r\n').filter(Boolean).length, 9);
    assert.doesNotMatch(eligibilityCsv, /资格回归 测试/u, 'CSV exports must also omit all testRun tasks');
    const fullInterval = await readTaskDataReport(db, admin, {
      time: { field: 'FIRST_COPY_REVIEW_ACTION', mode: 'ABSOLUTE', from: assignedDay, to: todayDay },
    });
    assert.equal(fullInterval.summary.packingDelivery, 2);
    assert.equal(fullInterval.overview.unpacked + fullInterval.overview.packed + fullInterval.overview.delivered,
      fullInterval.summary.packingDelivery, 'a range containing review and operation dates has identical delivery eligibility');
    assert.equal(fullInterval.items.some(item => item.taskName.startsWith('资格回归 测试')), false);
    const assignedCopyReview = await createTask('待审核口径回归 已分配普通待审核', false);
    await db.query(`UPDATE tasks SET state='COPY_REVIEW_PENDING',current_stage='COPY_REVIEW_PENDING',
      assigned_at=clock_timestamp() WHERE id=$1`, [assignedCopyReview.taskId]);
    await db.query(`UPDATE task_assignment_events SET created_at=(SELECT assigned_at FROM tasks WHERE id=$1)
      WHERE task_id=$1 AND previous_assignee_user_id IS NULL AND assignee_user_id=$2`,
    [assignedCopyReview.taskId, annotatorA.username]);
    const assignedCopyRework = await createTask('待审核口径回归 已分配返修待审核', false);
    await db.query(`UPDATE tasks SET state='COPY_REVIEW_PENDING',current_stage='COPY_REVIEW_PENDING',
      copy_qa_rework_pending=true WHERE id=$1`, [assignedCopyRework.taskId]);
    await db.query(`UPDATE tasks SET assigned_to_user_id=$2,assignment_source='MANUAL',assigned_at=now()
      WHERE id=$1`, [assignedCopyRework.taskId, annotatorB.username]);
    await db.query(`INSERT INTO task_assignment_events(task_id,actor_username,previous_assignee_user_id,
      assignee_user_id,source) VALUES($1,$2,$3,$4,'MANUAL')`,
    [assignedCopyRework.taskId, admin.username, annotatorA.username, annotatorB.username]);
    const secondAssignment = await createTask('待审核口径回归 待二次分配', false);
    await db.query(`UPDATE tasks SET state='PENDING_SECOND_ASSIGNMENT',current_stage='PENDING_SECOND_ASSIGNMENT',
      assigned_to_user_id=NULL,assignment_source=NULL,assigned_at=NULL WHERE id=$1`,
    [secondAssignment.taskId]);
    const unassignedCopyReview = await createTask('待审核口径回归 未分配文案待审核', false);
    await db.query(`UPDATE tasks SET state='COPY_REVIEW_PENDING',current_stage='COPY_REVIEW_PENDING',
      assigned_to_user_id=NULL,assignment_source=NULL,assigned_at=NULL WHERE id=$1`,
    [unassignedCopyReview.taskId]);
    const olderCopyReview = await createTask('待审核口径回归 昨日首次审核仍待处理', false);
    await db.query('UPDATE copy_approval_events SET approved_at=$2 WHERE id=$1',
      [olderCopyReview.approvalId, yesterdayAt]);
    await db.query('UPDATE copy_revisions SET approved_at=$2 WHERE id=$1',
      [olderCopyReview.revisionId, yesterdayAt]);
    await db.query(`UPDATE tasks SET state='COPY_REVIEW_PENDING',current_stage='COPY_REVIEW_PENDING',
      copy_qa_rework_pending=true WHERE id=$1`, [olderCopyReview.taskId]);
    const neverReviewedCopy = await createUnreviewedTask('待审核口径回归 已分配但从未审核', 'COPY_REVIEW_PENDING');
    const copyReviewQuery = {
      time: { field: 'FIRST_COPY_REVIEW_ACTION', mode: 'ABSOLUTE', from: todayDay, to: todayDay },
      conditions: [{ field: 'TASK_ID_OR_NAME', op: 'CONTAINS', value: '待审核口径回归' }],
    };
    const copyReviewReport = await readTaskDataReport(db, admin, copyReviewQuery);
    assert.equal(copyReviewReport.total, 4,
      'reviewed second-assignment and unassigned tasks remain visible in the detail cohort');
    assert.deepEqual(new Set(copyReviewReport.items.map(item => item.taskId)), new Set([
      assignedCopyReview.taskId, assignedCopyRework.taskId, secondAssignment.taskId, unassignedCopyReview.taskId,
    ]));
    assert.equal(copyReviewReport.summary.byState.COPY_REVIEW_PENDING, 3);
    assert.equal(copyReviewReport.summary.byState.PENDING_SECOND_ASSIGNMENT, 1);
    assert.equal(copyReviewReport.summary.copyReviewPending, 2,
      'the compatibility COPY review count retains assigned ordinary and returned tasks');
    assert.equal(copyReviewReport.summary.copyReworkPending, 1,
      'only the assigned task with an active QA return enters the new COPY rework count');
    assert.equal(copyReviewReport.summary.copyInitialReviewPending, 1,
      'only the current review round without an active QA return enters the new initial review count');
    assert.equal(copyReviewReport.summary.copyInitialReviewPending + copyReviewReport.summary.copyReworkPending,
      copyReviewReport.summary.copyReviewPending, 'reviewed initial and QA rework stages are mutually exclusive');

    assert.equal(copyReviewReport.summary.reviewPending, 2);
    assert.equal(copyReviewReport.summary.imageReviewPending, 0);
    for (const item of copyReviewReport.items) assert.ok(item.firstCopyReviewAt,
      'all four current-state cases have an actual first manual review in the selected date interval');
    assert.equal(copyReviewReport.items.find(item => item.taskId === assignedCopyRework.taskId).copyStatus, 'RETURNED');
    assert.equal(copyReviewReport.items.some(item => item.taskId === Number(neverReviewedCopy.id)), false,
      'first assignment alone still does not date unreviewed tasks into the first-review detail cohort');
    const reworkByPerson = await readTaskDataReport(db, admin, {
      ...copyReviewQuery,
      conditions: [...copyReviewQuery.conditions, { field: 'ANNOTATOR', op: 'EQ', value: annotatorB.userId }],
    });
    assert.deepEqual(reworkByPerson.items.map(item => item.taskId), [assignedCopyRework.taskId]);
    assert.equal(reworkByPerson.summary.copyInitialReviewPending, 0);
    assert.equal(reworkByPerson.summary.copyReworkPending, 1);
    assert.equal(reworkByPerson.summary.copyReviewPending, 1);
    const initialByPerson = await readTaskDataReport(db, admin, {
      ...copyReviewQuery,
      conditions: [
        { field: 'TASK_ID_OR_NAME', op: 'CONTAINS', value: '#' + assignedCopyReview.taskId },
        { field: 'ANNOTATOR', op: 'EQ', value: annotatorA.userId },
      ],
    });
    assert.deepEqual(initialByPerson.items.map(item => item.taskId), [assignedCopyReview.taskId]);
    assert.equal(initialByPerson.summary.copyInitialReviewPending, 1);
    assert.equal(initialByPerson.summary.copyReworkPending, 0);
    assert.equal(initialByPerson.summary.copyReviewPending, 1);
    const olderCopyReviewReport = await readTaskDataReport(db, admin, {
      ...copyReviewQuery,
      time: { field: 'FIRST_COPY_REVIEW_ACTION', mode: 'ABSOLUTE', from: yesterdayDay, to: yesterdayDay },
    });
    assert.deepEqual(olderCopyReviewReport.items.map(item => item.taskId), [olderCopyReview.taskId]);
    assert.equal(olderCopyReviewReport.summary.copyReviewPending, 1);
    assert.equal(olderCopyReviewReport.summary.copyInitialReviewPending, 0);
    assert.equal(olderCopyReviewReport.summary.copyReworkPending, 1);
    assert.equal(olderCopyReviewReport.items[0].firstCopyReviewAt, yesterdayAt.toISOString(),
      'current pending COPY review continues to use its lifecycle first review date rather than assignment date');

    const compatibleReworks = [];
    for (const origin of ['QA_RETURN', 'FINAL_REWORK', 'SECOND_ASSIGNMENT', 'DISCARD_RESTORE']) {
      const fixture = await createTask('返修兼容口径回归 已首审 ' + origin, false);
      await db.query(`UPDATE tasks SET state='COPY_REVIEW_PENDING',current_stage='COPY_REVIEW_PENDING',
        mandatory_copy_qc=true,mandatory_copy_qc_origin=$2 WHERE id=$1`, [fixture.taskId, origin]);
      compatibleReworks.push(fixture);
    }
    const flagOnlyReworks = [];
    for (const [rework, origin] of [[true, null], [false, 'QA_RETURN'], [false, 'FINAL_REWORK']]) {
      const fixture = await createUnreviewedTask('返修兼容口径回归 从未审核 ' + (origin ?? 'V2'), 'COPY_REVIEW_PENDING');
      await db.query(`UPDATE tasks SET copy_qa_rework_pending=$2,
        mandatory_copy_qc=$3,mandatory_copy_qc_origin=$4 WHERE id=$1`,
      [fixture.id, rework, origin !== null, origin]);
      flagOnlyReworks.push(fixture);
    }
    const compatibilityQuery = {
      time: { field: 'FIRST_COPY_REVIEW_ACTION', mode: 'ABSOLUTE', from: todayDay, to: todayDay },
      conditions: [{ field: 'TASK_ID_OR_NAME', op: 'CONTAINS', value: '返修兼容口径回归' }],
    };
    const compatibleReport = await readTaskDataReport(db, admin, compatibilityQuery);
    assert.equal(compatibleReport.total, 4);
    assert.deepEqual(new Set(compatibleReport.items.map(item => item.taskId)),
      new Set(compatibleReworks.map(fixture => fixture.taskId)));
    assert.equal(compatibleReport.summary.copyReviewPending, 4);
    assert.equal(compatibleReport.summary.copyReworkPending, 1,
      'legacy QA_RETURN is COPY QA rework; FINAL_REWORK, second assignment and restore alone are not');
    assert.equal(compatibleReport.summary.copyInitialReviewPending, 3,
      'FINAL_REWORK, completed second assignment and ordinary restore belong to a current non-QA-return review round');

    const createdCompatibility = await readTaskDataReport(db, admin, {
      ...compatibilityQuery,
      time: { field: 'CREATED_AT', mode: 'ABSOLUTE', from: todayDay, to: todayDay },
    });
    assert.equal(createdCompatibility.total, 7);
    assert.equal(createdCompatibility.summary.copyReviewPending, 7);
    assert.equal(createdCompatibility.summary.copyReworkPending, 1,
      'even when another supported time dimension includes them, return flags without first COPY review are insufficient');
    assert.equal(createdCompatibility.summary.copyInitialReviewPending, 4,
      'active QA return flags do not overlap initial review, including before a first review exists');

    for (const fixture of flagOnlyReworks) assert.equal(createdCompatibility.items.find(
      item => item.taskId === Number(fixture.id)).firstCopyReviewAt, null);

    async function copyQaReleaseMember(fixture, status, selected, batchStatus) {
      const batchId = Number((await db.query(`INSERT INTO copy_qa_batches_v2(mode,
        full_inspection,blind_review_enabled,sampling_rate_bps,return_threshold_bps,return_trigger_count,
        member_count,sample_count,status,created_by_account_id,completed_at)
        VALUES('MIXED_MANUAL',false,false,5000,5000,1,1,$1,$2::text,$3,
          CASE WHEN $2::text='INSPECTING' THEN NULL ELSE now() END) RETURNING id`,
      [selected ? 1 : 0, batchStatus, admin.userId])).rows[0].id);
      const memberId = Number((await db.query(`INSERT INTO copy_qa_batch_members_v2(batch_id,
        task_id,copy_revision_id,approval_event_id,approver_account_id,quality_cycle,content_sha256,
        selected,status,reviewed_by_account_id,decided_at)
        VALUES($1,$2,$3,$4,$5,0,$6,$7,$8,$9,
          CASE WHEN $9::bigint IS NULL THEN NULL ELSE now() END) RETURNING id`,
      [batchId, fixture.taskId, fixture.revisionId, fixture.approvalId, annotatorA.userId,
        'a'.repeat(64), selected, status, selected ? qaA.userId : null])).rows[0].id);
      return { ...fixture, batchId, memberId };
    }

    async function legacyCopyQaReleaseItem(fixture, freezeVersion, status, freezeStatus) {
      const freezeId = Number((await db.query(`INSERT INTO copy_sampling_freezes(public_id,
        production_batch_id,freeze_version,policy_version,rate_bps,seed,algorithm_version,
        blind_review_enabled,population_count,sample_count,snapshot_sha256,frozen_by_account_id,
        frozen_by_username,request_id,request_fingerprint,status,resolved_at)
        VALUES($1,$2,$3,1,0,'fixture','test',false,1,0,$4,$5,$6,$7,$4,$8::varchar,
          CASE WHEN $8::varchar='INSPECTING' THEN NULL ELSE now() END) RETURNING id`,
      [randomUUID(), productionBatch.id, freezeVersion, 'a'.repeat(64), admin.userId,
        admin.username, randomUUID(), freezeStatus])).rows[0].id);
      const itemId = Number((await db.query(`INSERT INTO copy_sampling_items(public_id,
        freeze_id,task_id,approval_event_id,copy_revision_id,content_sha256,final_approver_account_id,
        final_approver_username,rank_hash,selected,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$6,false,$9) RETURNING id`,
      [randomUUID(), freezeId, fixture.taskId, fixture.approvalId, fixture.revisionId,
        'a'.repeat(64), annotatorA.userId, annotatorA.username, status])).rows[0].id);
      return { ...fixture, freezeId, itemId };
    }

    const returnedFirst = await copyQaReleaseMember(
      await createTask('一次通过放行回归 首次退回后返修放行', true, qaA.userId),
      'RETURNED', true, 'AUTO_RETURNED');
    await db.query(`INSERT INTO copy_qa_return_events_v2(task_id,quality_cycle,member_id,kind)
      VALUES($1,0,$2,'DIRECT')`, [returnedFirst.taskId, returnedFirst.memberId]);
    const reworkRevisionId = Number((await db.query(`INSERT INTO copy_revisions(task_id,
      revision,content,parent_revision_id,revision_origin,approved_at,approval_mode)
      VALUES($1,2,'{}',$2,'QA_RETURN',now(),'MANUAL') RETURNING id`,
    [returnedFirst.taskId, returnedFirst.revisionId])).rows[0].id);
    const reworkApprovalId = Number((await db.query(`INSERT INTO copy_approval_events(task_id,
      copy_revision_id,approval_mode,approved_by_account_id,approved_by_username,content_sha256)
      VALUES($1,$2,'MANUAL',$3,$4,$5) RETURNING id`,
    [returnedFirst.taskId, reworkRevisionId, annotatorA.userId, annotatorA.username, 'a'.repeat(64)])).rows[0].id);
    await copyQaReleaseMember({ ...returnedFirst, revisionId: reworkRevisionId, approvalId: reworkApprovalId },
      'RELEASED', false, 'COMPLETED');
    await db.query(`UPDATE tasks SET current_copy_revision_id=$2,copy_qc_released_revision_id=$2,
      state='IMAGE_QUEUED',current_stage='IMAGE_QUEUED' WHERE id=$1`,
    [returnedFirst.taskId, reworkRevisionId]);
    const heldV2 = await copyQaReleaseMember(await createTask('一次通过放行回归 未完成V2批次', false),
      'NOT_SELECTED', false, 'INSPECTING');
    const legacyReleased = await legacyCopyQaReleaseItem(
      await createTask('一次通过放行回归 历史未抽中已放行', false),
      1, 'RELEASED', 'RELEASED_WITH_EXCEPTIONS');
    await db.query(`UPDATE tasks SET copy_qc_released_revision_id=$2,
      state='IMAGE_QUEUED',current_stage='IMAGE_QUEUED' WHERE id=$1`,
    [legacyReleased.taskId, legacyReleased.revisionId]);
    const heldLegacy = await legacyCopyQaReleaseItem(
      await createTask('一次通过放行回归 历史未抽中尚未放行', false),
      2, 'NOT_SELECTED', 'INSPECTING');
    const firstReleaseQuery = {
      time: { field: 'FIRST_COPY_REVIEW_ACTION', mode: 'ABSOLUTE', from: todayDay, to: todayDay },
      conditions: [{ field: 'TASK_ID_OR_NAME', op: 'CONTAINS', value: '一次通过放行回归' }],
    };
    let firstReleaseReport = await readTaskDataReport(db, admin, firstReleaseQuery);
    assert.equal(firstReleaseReport.total, 4);
    assert.equal(firstReleaseReport.summary.copyQaPassed, 2);
    assert.equal(firstReleaseReport.summary.copyQaFirstPassed, 1,
      'completed legacy release counts, while returned rework and unfinished batches do not');
    const returnedReleaseReport = await readTaskDataReport(db, admin, {
      ...firstReleaseQuery, conditions: [{ field: 'TASK_ID', op: 'EQ', value: returnedFirst.taskId }],
    });
    assert.equal(returnedReleaseReport.summary.copyQaPassed, 1);
    assert.equal(returnedReleaseReport.summary.copyQaFirstPassed, 0,
      'later QA_RETURN version release cannot undo a lifecycle QA return');

    await db.query("UPDATE copy_qa_batch_members_v2 SET status='RELEASED' WHERE id=$1", [heldV2.memberId]);
    firstReleaseReport = await readTaskDataReport(db, admin, firstReleaseQuery);
    assert.equal(firstReleaseReport.summary.copyQaFirstPassed, 1,
      'RELEASED member status alone does not pass an unfinished V2 batch');
    await db.query("UPDATE copy_qa_batches_v2 SET status='COMPLETED',completed_at=now() WHERE id=$1", [heldV2.batchId]);
    await db.query(`UPDATE tasks SET copy_qc_released_revision_id=$2,
      state='IMAGE_QUEUED',current_stage='IMAGE_QUEUED' WHERE id=$1`, [heldV2.taskId, heldV2.revisionId]);
    firstReleaseReport = await readTaskDataReport(db, admin, firstReleaseQuery);
    assert.equal(firstReleaseReport.summary.copyQaPassed, 3);
    assert.equal(firstReleaseReport.summary.copyQaFirstPassed, 2);

    await db.query("UPDATE copy_sampling_items SET status='RELEASED',updated_at=now() WHERE id=$1", [heldLegacy.itemId]);
    firstReleaseReport = await readTaskDataReport(db, admin, firstReleaseQuery);
    assert.equal(firstReleaseReport.summary.copyQaFirstPassed, 2,
      'RELEASED legacy item alone does not pass an unfinished freeze');
    await db.query("UPDATE copy_sampling_freezes SET status='RELEASED',resolved_at=now() WHERE id=$1", [heldLegacy.freezeId]);
    await db.query(`UPDATE tasks SET copy_qc_released_revision_id=$2,
      state='IMAGE_QUEUED',current_stage='IMAGE_QUEUED' WHERE id=$1`, [heldLegacy.taskId, heldLegacy.revisionId]);
    firstReleaseReport = await readTaskDataReport(db, admin, firstReleaseQuery);
    assert.equal(firstReleaseReport.summary.copyQaPassed, 4);
    assert.equal(firstReleaseReport.summary.copyQaFirstPassed, 3,
      'initial releases count only after completion, and returned rework stays excluded');

    await assert.rejects(readTaskDataReport(db, { ...admin, role: 'USER' }, query),
      /仅管理员/u);
  } finally {
    await repository.close();
    await database.stop();
  }
});
