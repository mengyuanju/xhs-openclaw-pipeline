import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { readTaskDataReport } from '../src/task-data-report.mjs';
import { TASK_ACTIVITY_QA_CTES } from '../src/task-activity-qa-facts.mjs';
import { recordQualityReviewCoverage } from '../src/quality-review-coverage.mjs';
import { startTemporaryPostgres18 } from './helpers/personal-postgres.mjs';

const DAY = '2026-09-20';
const BEFORE = '2026-09-19';
const AFTER = '2026-09-21';
const NODE_ID = 'report-activity-node';
const SHA = 'a'.repeat(64);
const ZERO = { copyReview: 0, copyRework: 0, copyQa: 0, imageReview: 0, imageQa: 0, imageQaPassed: 0 };
const at = (day, time = '12:00:00') => day + 'T' + time + '+08:00';
const difference = (after, before) => Object.fromEntries(
  Object.keys(ZERO).map(key => [key, after[key] - before[key]]),
);

test('activity overview counts personal handoff work and historical operations independently of task state', {
  skip: process.env.RUN_POSTGRES_E2E !== '1', timeout: 180_000,
}, async t => {
  const database = await startTemporaryPostgres18();
  const repository = new PostgresControlPlaneRepository({ connectionString: database.connectionString });
  try {
    await repository.initialize();
    const db = repository.pool;
    await db.query('INSERT INTO executor_nodes(id,name) VALUES($1,$2)', [NODE_ID, '操作概览测试机']);
    const rows = (await db.query(`INSERT INTO app_users(username,display_name,role,password_hash,
      status,copy_review_enabled,copy_qc_enabled,image_qc_enabled,created_at)
      VALUES('activity-admin','管理员','ADMIN','test-only','ACTIVE',true,true,true,'2025-01-01'),
        ('activity-a','标注甲','USER','test-only','ACTIVE',true,false,false,'2025-01-01'),
        ('activity-b','标注乙','USER','test-only','ACTIVE',true,false,false,'2025-01-01')
      RETURNING id,username,role,credential_version`)).rows;
    const [admin, a, b] = rows.map(row => ({
      userId: Number(row.id), username: row.username, role: row.role,
      credentialVersion: Number(row.credential_version),
    }));
    const annotator = person => ({ field: 'ANNOTATOR', op: 'EQ', value: person.userId });
    async function report(day = DAY, conditions = []) {
      return readTaskDataReport(db, admin, {
        time: { field: 'FIRST_COPY_REVIEW_ACTION', mode: 'ABSOLUTE', from: day, to: day },
        conditions,
      });
    }
    async function activity(day = DAY, conditions = []) {
      const result = await report(day, conditions);
      assert.deepEqual(Object.keys(result.activityOverview).sort(), Object.keys(ZERO).sort());
      return result.activityOverview;
    }
    assert.deepEqual(await activity(), ZERO);

    async function task(name, { owner = a, testRun = false } = {}) {
      const id = Number((await db.query(`INSERT INTO tasks(query,input,state,current_stage,
        created_by_node_id,created_by_user_id,assigned_to_user_id,assignment_source,assigned_at,created_at)
        VALUES($1,$2,'COPY_REVIEW_PENDING','COPY_REVIEW_PENDING',$3,$4,$4,'MANUAL',
          '2026-08-02T08:00:00+08:00','2026-08-01T08:00:00+08:00') RETURNING id`,
      [name, { testRun }, NODE_ID, owner.username])).rows[0].id);
      const fixture = { taskId: id, name, owner };
      await revision(fixture);
      return fixture;
    }
    async function revision(fixture, { origin = 'GENERATION', parentId = null,
      approvedAt = null, approvalMode = 'MANUAL', rework = false } = {}) {
      fixture.copyRevisionId = Number((await db.query(`INSERT INTO copy_revisions(task_id,revision,content,
        parent_revision_id,revision_origin,approved_at,approval_mode,copy_rework_satisfied)
        SELECT $1,COALESCE(max(revision),0)+1,'{}',$2,$3,$4,CASE WHEN $4::timestamptz IS NULL THEN NULL ELSE $5 END,$6
        FROM copy_revisions WHERE task_id=$1 RETURNING id`,
      [fixture.taskId, parentId, origin, approvedAt, approvalMode, rework])).rows[0].id);
      await db.query('UPDATE tasks SET current_copy_revision_id=$2 WHERE id=$1',
        [fixture.taskId, fixture.copyRevisionId]);
      return fixture.copyRevisionId;
    }
    async function human(fixture, stage, action, occurredAt, { session = randomUUID(), reviewer = fixture.owner } = {}) {
      await db.query(`INSERT INTO human_quality_review_submissions(review_session_id,task_id,stage,
        reviewer_username,request_fingerprint,created_at) VALUES($1,$2,$3,$4,$5,$6)`,
      [session, fixture.taskId, stage, reviewer.username, SHA, occurredAt]);
      return Number((await db.query(`INSERT INTO human_quality_assessments(task_id,stage,
        copy_revision_id,image_run_id,score_x10,rating_context,action,reviewer_username,
        review_session_id,request_fingerprint,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [fixture.taskId, stage, stage === 'COPY' ? fixture.copyRevisionId : null,
        stage === 'IMAGE' ? fixture.imageRunId : null, action === 'APPROVE' ? 30 : action === 'DISCARD' ? 10 : 20,
        stage === 'COPY' ? 'ORIGINAL' : 'IMAGE', action, reviewer.username, session, SHA, occurredAt])).rows[0].id);
    }
    async function copyApproval(fixture, occurredAt, { mode = 'MANUAL', session = randomUUID(),
      assessmentId = null, actor = fixture.owner } = {}) {
      await db.query(`UPDATE copy_revisions SET approved_at=$2,approval_mode=$3 WHERE id=$1`,
        [fixture.copyRevisionId, occurredAt, mode]);
      fixture.copyApprovalId = Number((await db.query(`INSERT INTO copy_approval_events(task_id,
        copy_revision_id,assessment_id,approval_mode,approved_by_account_id,approved_by_username,
        review_session_id,content_sha256,approved_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [fixture.taskId, fixture.copyRevisionId, assessmentId, mode, actor.userId, actor.username,
        session, SHA, occurredAt])).rows[0].id);
      return fixture.copyApprovalId;
    }
    async function image(fixture, occurredAt, { approval = true, owner = fixture.owner, session = randomUUID(), reuseRun = false } = {}) {
      if (!reuseRun) {
        fixture.imageRunId = randomUUID();
        await db.query(`INSERT INTO image_runs(id,task_id,copy_revision_id,status,result,image_production_chain_id)
          VALUES($1,$2,$3,'COMPLETED','{}',$1)`, [fixture.imageRunId, fixture.taskId, fixture.copyRevisionId]);
        await db.query('UPDATE tasks SET current_image_run_id=$2 WHERE id=$1', [fixture.taskId, fixture.imageRunId]);
      }
      if (approval) fixture.imageApprovalId = Number((await db.query(`INSERT INTO image_approval_events(task_id,
        copy_revision_id,image_run_id,submitted_by_account_id,submitted_by_username,review_session_id,
        image_set_sha256,submitted_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [fixture.taskId, fixture.copyRevisionId, fixture.imageRunId, owner.userId, owner.username,
        session, SHA, occurredAt])).rows[0].id);
      fixture.imageReviewSessionId = session;
      return fixture;
    }
    async function reassign(fixture, target, occurredAt) {
      const previousUsername = fixture.owner?.username ?? null;
      const targetUsername = target?.username ?? null;
      await db.query(`UPDATE tasks SET assigned_to_user_id=$2,
        assignment_source=CASE WHEN $2::varchar IS NOT NULL THEN 'MANUAL' END,
        assigned_at=CASE WHEN $2::varchar IS NOT NULL THEN $3::timestamptz END
        WHERE id=$1`, [fixture.taskId, targetUsername, occurredAt]);
      // The real trigger closes the old record at the DB clock; fixtures use historical handoff times.
      await db.query(`UPDATE task_assignment_records SET ended_at=GREATEST(assigned_at,$2::timestamptz)
        WHERE id=(SELECT id FROM task_assignment_records WHERE task_id=$1 AND ended_at IS NOT NULL
          ORDER BY id DESC LIMIT 1)`, [fixture.taskId, occurredAt]);
      await db.query(`INSERT INTO task_assignment_events(task_id,actor_username,previous_assignee_user_id,
        assignee_user_id,source,created_at) VALUES($1,$2,$3,$4,'MANUAL',$5)`,
      [fixture.taskId, admin.username, previousUsername, targetUsername, occurredAt]);
      fixture.owner = target;
    }
    async function archive(fixture, { deleteLive = true } = {}) {
      const caseId = Number((await db.query(`INSERT INTO task_reassignment_cases(task_id,stage,
        source_item_public_id,operator_account_id,reviewer_account_id,status,reset_status,note)
        VALUES($1,'COPY',$2,$3,$4,'REASSIGNED','READY','历史审核回归归档') RETURNING id`,
      [fixture.taskId, randomUUID(), admin.userId, b.userId])).rows[0].id);
      await db.query(`INSERT INTO task_reassignment_assessment_records(case_id,assessment_id,task_id,
        stage,score_x10,rating_context,action,reason_codes,reviewer_username,created_at)
        SELECT $1,id,task_id,stage,score_x10,rating_context,action,reason_codes,reviewer_username,created_at
        FROM human_quality_assessments WHERE task_id=$2`, [caseId, fixture.taskId]);
      if (deleteLive) await db.query('DELETE FROM human_quality_review_submissions WHERE task_id=$1', [fixture.taskId]);
    }
    async function productionBatch() {
      return Number((await db.query(`INSERT INTO production_batches(public_id,query_package_name,
        created_by_username,request_id,request_fingerprint,client_batch_code)
        VALUES($1,'activity-test',$2,$3,$4,$5) RETURNING id`,
      [randomUUID(), admin.username, randomUUID(), SHA, randomUUID().replaceAll('-', '')])).rows[0].id);
    }
    async function freeze(stage, { owner = a } = {}) {
      const batchId = await productionBatch();
      const common = [randomUUID(), batchId, SHA, admin.username, randomUUID()];
      if (stage === 'COPY') return Number((await db.query(`INSERT INTO copy_sampling_freezes(public_id,
        production_batch_id,policy_version,rate_bps,seed,algorithm_version,blind_review_enabled,
        population_count,sample_count,snapshot_sha256,frozen_by_username,request_id,request_fingerprint,frozen_at)
        VALUES($1,$2,1,10000,'test','test',false,20,20,$3,$4,$5,$3,'2026-09-01') RETURNING id`, common)).rows[0].id);
      return Number((await db.query(`INSERT INTO image_sampling_freezes(public_id,
        production_batch_id,policy_version,rate_bps,seed,algorithm_version,blind_review_enabled,
        population_count,sample_count,snapshot_sha256,frozen_by_username,request_id,
        submitter_account_id,close_reason,frozen_at)
        VALUES($1,$2,1,10000,'test','test',false,20,20,$3,$4,$5,$6,'MANUAL','2026-09-01') RETURNING id`,
      [...common, owner.userId])).rows[0].id);
    }
    async function sample(fixture, stage, freezeId, { status = 'PENDING', selected = true, occurredAt = null } = {}) {
      const values = [randomUUID(), freezeId, fixture.taskId, stage === 'COPY' ? fixture.copyApprovalId : fixture.imageApprovalId,
        fixture.copyRevisionId, SHA, fixture.owner.userId, fixture.owner.username, selected, status, occurredAt];
      const itemId = stage === 'COPY' ? Number((await db.query(`INSERT INTO copy_sampling_items(public_id,freeze_id,
        task_id,approval_event_id,copy_revision_id,content_sha256,final_approver_account_id,final_approver_username,
        rank_hash,selected,status,reviewed_at,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$6,$9,$10,$11::timestamptz,'2026-09-01',COALESCE($11::timestamptz,'2026-09-01')) RETURNING id`,
      values)).rows[0].id) : Number((await db.query(`INSERT INTO image_sampling_items(public_id,freeze_id,task_id,
        approval_event_id,copy_revision_id,image_run_id,image_set_sha256,submitter_account_id,submitter_username,
        rank_hash,selected,status,reviewed_at,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$12,$6,$7,$8,$6,$9,$10,$11::timestamptz,'2026-09-01',COALESCE($11::timestamptz,'2026-09-01')) RETURNING id`,
      [...values, fixture.imageRunId])).rows[0].id);
      return { ...fixture, stage, freezeId, itemId };
    }
    async function qaEvent(sampled, action, occurredAt, { batch = false, details = {} } = {}) {
      const table = sampled.stage === 'COPY' ? 'copy_sampling_events' : 'image_sampling_events';
      const requestId = randomUUID();
      const id = Number((await db.query('INSERT INTO ' + table + `(freeze_id,sampling_item_id,action,actor_account_id,
        actor_username,request_id,details,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [sampled.freezeId, batch ? null : sampled.itemId, action, admin.userId, admin.username,
        requestId, details, occurredAt])).rows[0].id);
      return { id, requestId };
    }
    async function legacyQaTask(name, stage, freezeId, { status = 'PENDING', selected = true,
      occurredAt = null, testRun = false } = {}) {
      const fixture = await task(name, { testRun });
      await copyApproval(fixture, at('2026-09-01'));
      if (stage === 'IMAGE') await image(fixture, at('2026-09-01'));
      return sample(fixture, stage, freezeId, { status, selected, occurredAt });
    }

    async function releaseCoverage(sampled, event, occurredAt, selected) {
      const operationKey = sampled.stage + ':legacy:release:' + sampled.freezeId + ':' + event.requestId;
      const input = {
        accountId: admin.userId, taskId: sampled.taskId, stage: sampled.stage,
        reviewItemKey: sampled.stage + ':legacy:' + sampled.freezeId + ':' + sampled.taskId,
        kind: 'BATCH_RELEASE', operationKey, occurredAt,
        data: { freezeId: sampled.freezeId, samplingItemId: sampled.itemId,
          approvalId: sampled.stage === 'COPY' ? sampled.copyApprovalId : sampled.imageApprovalId,
          copyRevisionId: sampled.copyRevisionId, imageRunId: sampled.imageRunId, selected,
          sourceEventId: event.id, source: 'LEGACY_RELEASE' },
      };
      assert.equal(await recordQualityReviewCoverage(db, input), true);
      assert.equal(await recordQualityReviewCoverage(db, input), false,
        'replaying one successful release operation does not create another coverage event');
    }
    async function v2Batch({ legacyFreezeId = null, completedAt = at(DAY, '12:00:00') } = {}) {
      return Number((await db.query(`INSERT INTO copy_qa_batches_v2(mode,legacy_freeze_id,
        return_threshold_bps,return_trigger_count,member_count,sample_count,status,created_at,completed_at)
        VALUES($1,$2,5000,2,4,2,'COMPLETED','2026-09-01',$3) RETURNING id`,
      [legacyFreezeId === null ? 'MIXED_MANUAL' : 'SYSTEM_MIGRATION', legacyFreezeId, completedAt])).rows[0].id);
    }
    async function v2Member(fixture, batchId, status, occurredAt) {
      return Number((await db.query(`INSERT INTO copy_qa_batch_members_v2(batch_id,task_id,
        copy_revision_id,approval_event_id,approver_account_id,quality_cycle,content_sha256,selected,status,
        reviewed_by_account_id,decided_at,created_at)
        VALUES($1,$2,$3,$4,$5,0,$6,$7,$8,$9,$10,'2026-09-01') RETURNING id`,
      [batchId, fixture.taskId, fixture.copyRevisionId, fixture.copyApprovalId, fixture.owner.userId, SHA,
        status !== 'RELEASED', status, status === 'RELEASED' ? null : admin.userId, occurredAt])).rows[0].id);
    }

    await t.test('personal first COPY work follows valid submissions and deduplicated direct discards', async () => {
      const initial = await activity();
      const approved = await task('首次通过且评分与审批事件同时存在');
      const session = randomUUID();
      const assessmentId = await human(approved, 'COPY', 'APPROVE', at(DAY, '08:00:00'), { session });
      await copyApproval(approved, at(DAY, '08:00:00'), { session, assessmentId });
      await human(approved, 'COPY', 'APPROVE', at(DAY, '08:01:00'));
      await archive(approved, { deleteLive: false });
      const discarded = await task('首次审核废弃');
      await human(discarded, 'COPY', 'DISCARD', at(DAY, '09:00:00'));
      await db.query("UPDATE tasks SET state='CANCELLED',cancelled_from_state='COPY_REVIEW_PENDING' WHERE id=$1",
        [discarded.taskId]);
      await archive(discarded, { deleteLive: false });
      const retried = await task('仅重试即使归档也不构成有效首次作业');
      await human(retried, 'COPY', 'RETRY', at(DAY, '10:00:00'));
      await archive(retried);
      assert.equal(Number((await db.query('SELECT count(*) FROM human_quality_assessments WHERE task_id=$1',
        [retried.taskId])).rows[0].count), 0, 'the actual submission FK cascade removed live review records');
      await copyApproval(retried, at(AFTER));
      const older = await task('前人首次在范围之前，新接手提交计本人的首次');
      await copyApproval(older, at(BEFORE, '09:00:00'));
      const oldRevisionId = older.copyRevisionId;
      await reassign(older, b, at(DAY, '06:00:00'));
      await revision(older, { origin: 'SECOND_ASSIGNMENT_RESET', parentId: oldRevisionId });
      await copyApproval(older, at(DAY, '11:00:00'));
      const saveOnly = await task('仅存草稿不构成首次审核');
      await human(saveOnly, 'COPY', 'SAVE', at(DAY, '07:00:00'));
      const bypass = await task('管理员免人工审核不冒充首次人工审核');
      await copyApproval(bypass, at(DAY, '13:00:00'), { mode: 'ADMIN_BYPASS', actor: admin });
      assert.deepEqual(difference(await activity(), initial), { ...ZERO, copyReview: 3 });
      await reassign(approved, b, at(AFTER));
      assert.equal((await activity(DAY, [annotator(a)])).copyReview, 2,
        'completed submissions and actor discards count, while SAVE and RETRY-only records do not');
      assert.equal((await activity(DAY, [annotator(b)])).copyReview, 1,
        'the new owner first submission starts their personal first without taking the old owner work');
      await db.query('DELETE FROM human_quality_review_submissions WHERE task_id=$1', [discarded.taskId]);
      assert.deepEqual(difference(await activity(), initial), { ...ZERO, copyReview: 3 },
        'archiving and subsequently clearing the live direct-discard record preserves one operation');
      assert.equal((await activity(AFTER, [annotator(a)])).copyReview, 1,
        'an earlier RETRY-only record does not consume the later first valid submission');
    });

    await t.test('COPY rework counts every completed resubmission on its submission day', async () => {
      const initial = await activity();
      const fixture = await task('同任务两次返修提交');
      await copyApproval(fixture, at(BEFORE, '08:00:00'));
      const oldId = fixture.copyRevisionId;
      await revision(fixture, { origin: 'QA_RETURN', parentId: oldId });
      await human(fixture, 'COPY', 'SAVE', at(BEFORE, '18:00:00'));
      const savedId = fixture.copyRevisionId;
      await revision(fixture, { origin: 'COPY_EDIT', parentId: savedId, rework: true });
      await human(fixture, 'COPY', 'SAVE', at(DAY, '09:00:00'));
      await copyApproval(fixture, at(DAY, '12:00:00'));
      await human(fixture, 'COPY', 'APPROVE', at(DAY, '12:00:00'));
      const firstReworkId = fixture.copyRevisionId;
      await revision(fixture, { origin: 'QA_RETURN', parentId: firstReworkId });
      const returnedId = fixture.copyRevisionId;
      await revision(fixture, { origin: 'COPY_EDIT', parentId: returnedId, rework: true });
      await copyApproval(fixture, at(DAY, '18:00:00'));
      await archive(fixture);
      await reassign(fixture, b, at(AFTER));
      assert.deepEqual(difference(await activity(), initial), { ...ZERO, copyRework: 2 });
      assert.equal((await activity(DAY, [annotator(b)])).copyRework, 0);
      assert.equal((await activity(BEFORE)).copyRework, 0,
        'the returned draft and saves do not count as completed rework submissions');
    });

    await t.test('IMAGE review combines modern submissions with legacy decisions without archive duplication', async () => {
      const initialReport = await report();
      const initial = initialReport.activityOverview;
      const initialPerson = initialReport.activityPeople.find(person => person.accountId === a.userId);
      const modern = await task('同任务两次图片初审提交');
      await copyApproval(modern, at('2026-09-01'));
      await image(modern, at(DAY, '10:00:00'));
      const firstImageApprovalId = modern.imageApprovalId;
      await human(modern, 'IMAGE', 'APPROVE', at(DAY, '10:00:00'), { session: modern.imageReviewSessionId });
      await archive(modern);
      await db.query('DELETE FROM image_approval_events WHERE id=$1', [firstImageApprovalId]);
      assert.ok((await db.query('SELECT event_key FROM operator_performance_events WHERE event_key=$1',
        ['image-submit:' + firstImageApprovalId])).rows[0],
      'the actual source trigger retains an immutable submission fact after the approval row is removed');
      await image(modern, at(DAY, '16:00:00'));
      const legacy = await task('旧图片审核记录归档');
      await copyApproval(legacy, at('2026-09-01'));
      await image(legacy, at(BEFORE), { approval: false });
      await human(legacy, 'IMAGE', 'RETRY', at(DAY, '11:00:00'));
      await archive(legacy, { deleteLive: false });
      await reassign(modern, b, at(AFTER));
      const currentReport = await report();
      assert.deepEqual(difference(currentReport.activityOverview, initial), { ...ZERO, imageReview: 3 });
      const currentPerson = currentReport.activityPeople.find(person => person.accountId === a.userId);
      assert.equal(currentPerson.imageFirstReview - (initialPerson?.imageFirstReview ?? 0), 2);
      assert.equal(currentPerson.imageRework - (initialPerson?.imageRework ?? 0), 1);
      assert.equal(currentPerson.imageReview,
        currentPerson.imageFirstReview + currentPerson.imageRework);
      assert.equal((await activity(DAY, [annotator(b)])).imageReview, 0);
    });

    await t.test('IMAGE first work restarts after a handoff back to the same annotator', async () => {
      const beforeA = (await report(DAY, [annotator(a)])).activityPeople
        .find(person => person.accountId === a.userId);
      const beforeB = (await report(DAY, [annotator(b)])).activityPeople
        .find(person => person.accountId === b.userId);
      const fixture = await task('图片接手轮次首次与返修');
      await copyApproval(fixture, at('2026-09-01'));
      await image(fixture, at(DAY, '08:00:00'));
      await image(fixture, at(DAY, '09:00:00'));
      await reassign(fixture, b, at(DAY, '10:00:00'));
      await image(fixture, at(DAY, '11:00:00'));
      await reassign(fixture, a, at(DAY, '12:00:00'));
      await image(fixture, at(DAY, '13:00:00'));
      const afterA = (await report(DAY, [annotator(a)])).activityPeople
        .find(person => person.accountId === a.userId);
      const afterB = (await report(DAY, [annotator(b)])).activityPeople
        .find(person => person.accountId === b.userId);
      assert.equal(afterA.imageFirstReview - (beforeA?.imageFirstReview ?? 0), 2);
      assert.equal(afterA.imageRework - (beforeA?.imageRework ?? 0), 1);
      assert.equal(afterB.imageFirstReview - (beforeB?.imageFirstReview ?? 0), 1);
    });

    await t.test('legacy QA counts each affected task and includes batch release without counting passed items twice', async () => {
      const initial = await activity();
      for (const stage of ['COPY', 'IMAGE']) {
        const freezeId = await freeze(stage);
        const passed = await legacyQaTask(stage + '单条通过', stage, freezeId,
          { status: 'PASSED', occurredAt: at(DAY, '10:00:00') });
        const released = await legacyQaTask(stage + '批次免检放行', stage, freezeId,
          { status: 'RELEASED', selected: false, occurredAt: at(DAY, '12:00:00') });
        await qaEvent(passed, 'PASS', at(DAY, '10:00:00'));
        const release = await qaEvent(released, 'RELEASE', at(DAY, '12:00:00'), {
          batch: true, details: { taskIds: [passed.taskId, released.taskId], coverageRecorded: true },
        });
        await releaseCoverage(passed, release, at(DAY, '12:00:00'), true);
        await releaseCoverage(released, release, at(DAY, '12:00:00'), false);
        const returnFreeze = await freeze(stage);
        const returnedA = await legacyQaTask(stage + '整批退回甲', stage, returnFreeze,
          { status: 'BATCH_RETURNED', occurredAt: at(DAY, '14:00:00') });
        const returnedB = await legacyQaTask(stage + '整批退回乙', stage, returnFreeze,
          { status: 'BATCH_RETURNED', selected: false, occurredAt: at(DAY, '14:00:00') });
        await qaEvent(returnedA, 'RETURN_BATCH', at(DAY, '14:00:00'), {
          batch: true, details: { affectedTaskIds: [returnedA.taskId, returnedB.taskId], affectedCount: 2 },
        });
        await reassign(released, b, at(AFTER));
      }
      assert.deepEqual(difference(await activity(), initial), {
        ...ZERO, copyQa: 4, imageQa: 4, imageQaPassed: 2,
      });
      assert.equal((await activity(DAY, [annotator(b)])).imageQa, 0,
        'QA actor and later assignee cannot replace the historical annotator owner');
    });

    await t.test('legacy IMAGE passed timestamps fill missing events without duplicating real PASS operations', async () => {
      const initial = await activity();
      const freezeId = await freeze('IMAGE');
      await legacyQaTask('历史图片质检通过仅保留审核时间', 'IMAGE', freezeId,
        { status: 'PASSED', occurredAt: at(DAY, '10:00:00') });
      const withEvent = await legacyQaTask('历史图片质检通过已有真实PASS事件', 'IMAGE', freezeId,
        { status: 'PASSED', occurredAt: at(DAY, '11:00:00') });
      await qaEvent(withEvent, 'PASS', at(DAY, '11:00:00'));
      assert.deepEqual(difference(await activity(), initial), {
        ...ZERO, imageQa: 2, imageQaPassed: 2,
      }, 'a missing legacy verdict event is recovered once, while the real PASS keeps its single count');
    });

    await t.test('IMAGE QA counts a return and a later passed recheck as separate operations for the same task', async () => {
      const initial = await activity();
      const fixture = await task('同一图片任务打回后复检通过');
      await copyApproval(fixture, at('2026-09-01'));
      await image(fixture, at('2026-09-01'));
      const firstFreeze = await freeze('IMAGE');
      const returned = await sample(fixture, 'IMAGE', firstFreeze,
        { status: 'RETURNED', occurredAt: at(DAY, '10:00:00') });
      await qaEvent(returned, 'RETURN_SINGLE', at(DAY, '10:00:00'));
      await image(fixture, at(DAY, '16:00:00'));
      const secondFreeze = await freeze('IMAGE');
      const rechecked = await sample(fixture, 'IMAGE', secondFreeze,
        { status: 'PASSED', occurredAt: at(DAY, '18:00:00') });
      await qaEvent(rechecked, 'PASS', at(DAY, '18:00:00'));
      assert.deepEqual(difference(await activity(), initial), {
        ...ZERO, imageReview: 1, imageQa: 2, imageQaPassed: 1,
      }, 'an initial failed inspection and its successful recheck remain two historical operations');
    });

    await t.test('IMAGE QA discard preserves the sampled submitter across same-run resubmissions without assignment history', async () => {
      const initial = await activity();
      const initialA = (await activity(DAY, [annotator(a)])).imageQa;
      const initialB = (await activity(DAY, [annotator(b)])).imageQa;
      assert.ok(a.userId < b.userId, 'the earlier account must not win the historical attribution by numeric order');
      async function discard(fixture, samplingItemId = null) {
        await db.query(`INSERT INTO image_task_dispositions(task_id,copy_revision_id,image_run_id,
          sampling_item_id,from_state,note,actor_account_id,actor_username,actor_role,request_id,created_at)
          VALUES($1,$2,$3,$4,'IMAGE_QC_PENDING','同图多轮初审归属回归',$5,$6,'ADMIN',$7,$8)`,
        [fixture.taskId, fixture.copyRevisionId, fixture.imageRunId, samplingItemId,
          admin.userId, admin.username, randomUUID(), at(DAY, '12:00:00')]);
        await db.query('DELETE FROM task_assignment_records WHERE task_id=$1', [fixture.taskId]);
        await db.query('DELETE FROM task_assignment_events WHERE task_id=$1', [fixture.taskId]);
      }
      async function assertDiscardOwner(fixture, expectedAccountId) {
        const facts = (await db.query(`WITH ${TASK_ACTIVITY_QA_CTES}
          SELECT subject_account_id FROM qa_image_discard WHERE task_id=$1`, [fixture.taskId])).rows;
        assert.equal(facts.length, 1, 'one disposition must not fan out to all approvals for the image run');
        assert.equal(facts[0].subject_account_id === null ? null : Number(facts[0].subject_account_id),
          expectedAccountId);
      }

      const sampled = await task('同图采样项固定归属标注乙');
      await copyApproval(sampled, at(BEFORE));
      await image(sampled, at(BEFORE), { owner: a });
      await image(sampled, at(DAY, '08:00:00'), { owner: b, reuseRun: true });
      const target = await sample({ ...sampled, owner: b }, 'IMAGE', await freeze('IMAGE', { owner: b }));
      await image(sampled, at(DAY, '10:00:00'), { owner: a, reuseRun: true });
      await discard(sampled, target.itemId);
      await assertDiscardOwner(sampled, b.userId);

      const historical = await task('缺采样项按废弃时点归属标注乙');
      await copyApproval(historical, at(BEFORE));
      await image(historical, at(BEFORE), { owner: a });
      await image(historical, at(DAY, '08:00:00'), { owner: b, reuseRun: true });
      await discard(historical);
      await image(historical, at(DAY, '16:00:00'), { owner: a, reuseRun: true });
      await assertDiscardOwner(historical, b.userId);

      const unknown = await task('缺采样项且废弃前没有可信初审');
      await copyApproval(unknown, at(BEFORE));
      await image(unknown, at(DAY, '16:00:00'), { owner: a });
      await discard(unknown);
      await assertDiscardOwner(unknown, null);

      assert.equal((await activity()).imageQa - initial.imageQa, 3,
        'each discard contributes one operation even when its submitter is unknown');
      assert.equal((await activity(DAY, [annotator(b)])).imageQa - initialB, 2,
        'without assignment history both known discards belong to the correct submitted approval');
      assert.equal((await activity(DAY, [annotator(a)])).imageQa, initialA,
        'other same-run submissions and future approvals cannot acquire historical discard operations');
    });

    await t.test('COPY V2 decisions and migrated legacy duplicates retain one operation per real outcome', async () => {
      const initial = await activity();
      const batchId = await v2Batch({ completedAt: at(DAY, '16:00:00') });
      for (const [status, time] of [
        ['PASSED', '10:00:00'], ['RETURNED', '12:00:00'], ['BATCH_AFFECTED', '12:00:00'], ['RELEASED', '16:00:00'],
      ]) {
        const fixture = await task('新文案质检 ' + status);
        await copyApproval(fixture, at('2026-09-01'));
        await v2Member(fixture, batchId, status, at(DAY, time));
      }
      const legacyFreeze = await freeze('COPY');
      const migrated = await legacyQaTask('同一质检通过的旧记录及迁移副本', 'COPY', legacyFreeze,
        { status: 'PASSED', occurredAt: at(DAY, '14:00:00') });
      await qaEvent(migrated, 'PASS', at(DAY, '14:00:00'));
      const migrationBatch = await v2Batch({ legacyFreezeId: legacyFreeze, completedAt: at(DAY, '14:00:00') });
      await v2Member(migrated, migrationBatch, 'PASSED', at(DAY, '14:00:00'));
      const repeatedFreeze = await freeze('COPY');
      const repeated = await legacyQaTask('同版本不同时刻真实再质检', 'COPY', repeatedFreeze,
        { status: 'PASSED', occurredAt: at(DAY, '11:00:00') });
      await qaEvent(repeated, 'PASS', at(DAY, '11:00:00'));
      const repeatedBatch = await v2Batch({ legacyFreezeId: repeatedFreeze, completedAt: at(DAY, '15:00:00') });
      await v2Member(repeated, repeatedBatch, 'PASSED', at(DAY, '15:00:00'));
      const returnedFreeze = await freeze('COPY');
      const returned = await legacyQaTask('真实旧质检打回及0088迁移返回副本', 'COPY', returnedFreeze,
        { status: 'RETURNED', occurredAt: at(DAY, '18:00:00') });
      await qaEvent(returned, 'RETURN_SINGLE', at(DAY, '18:00:00'));
      await db.query(`INSERT INTO copy_qa_return_events_v2(task_id,quality_cycle,legacy_item_id,kind,created_at)
        VALUES($1,0,$2,'DIRECT',$3)`, [returned.taskId, returned.itemId, at(DAY, '18:00:00')]);
      assert.deepEqual(difference(await activity(), initial), { ...ZERO, copyQa: 8 },
        'mapped same-time shadows and copied return records count once, while a later real decision counts again');
    });

    await t.test('Beijing day bounds, test tasks and detail-only filters do not alter activity semantics', async () => {
      const initial = await activity();
      for (const [label, occurredAt] of [
        ['开始', at(DAY, '00:00:00')], ['当日末尾', at(DAY, '23:59:59.999')],
        ['开始之前', at(BEFORE, '23:59:59.999')], ['结束之后', at(AFTER, '00:00:00')],
      ]) {
        const fixture = await task('边界人工审核 ' + label);
        const session = randomUUID();
        const assessmentId = await human(fixture, 'COPY', 'APPROVE', occurredAt, { session });
        await copyApproval(fixture, occurredAt, { session, assessmentId });
      }
      const fake = await task('testRun每类操作都排除', { testRun: true });
      await revision(fake, { rework: true });
      await human(fake, 'COPY', 'APPROVE', at(DAY));
      await copyApproval(fake, at(DAY));
      await image(fake, at(DAY));
      const copyFreeze = await freeze('COPY');
      const copySample = await sample(fake, 'COPY', copyFreeze, { status: 'PASSED', occurredAt: at(DAY) });
      await qaEvent(copySample, 'PASS', at(DAY));
      const imageFreeze = await freeze('IMAGE');
      const imageSample = await sample(fake, 'IMAGE', imageFreeze, { status: 'PASSED', occurredAt: at(DAY) });
      await qaEvent(imageSample, 'PASS', at(DAY));
      const current = await report();
      assert.deepEqual(difference(current.activityOverview, initial), { ...ZERO, copyReview: 2 });
      for (const metric of ['copyReview', 'copyRework', 'imageReview']) {
        assert.equal(current.activityPeople.reduce((sum, person) => sum + person[metric], 0),
          current.activityOverview[metric], `${metric} personnel rows reconcile with the overview`);
      }
      assert.equal(current.activityPeople.reduce((sum, person) => sum + person.imagePassed, 0), 0,
        'QA decisions alone do not count as final image releases');
      for (const person of current.activityPeople) {
        assert.equal(person.imageReview, person.imageFirstReview + person.imageRework);
      }
      const filtered = await report(DAY, [
        { field: 'STATE', op: 'EQ', value: 'IMAGE_FAILED' },
        { field: 'TASK_ID_OR_NAME', op: 'CONTAINS', value: 'definitely-no-matching-task' },
        { field: 'REJECTION_COUNT', op: 'GTE', value: 99 },
        { field: 'REASSIGNMENT_COUNT', op: 'GTE', value: 99 },
        { field: 'COPY_QA_REVIEWER', op: 'EQ', value: admin.userId },
        { field: 'IMAGE_QA_REVIEWER', op: 'EQ', value: admin.userId },
      ]);
      assert.equal(filtered.total, 0);
      assert.deepEqual(filtered.activityOverview, current.activityOverview);
      assert.deepEqual(filtered.activityPeople, current.activityPeople,
        'task-level conditions do not affect the personnel activity overview');
      assert.ok(current.activityOverview.imageQaPassed <= current.activityOverview.imageQa);
    });

    await t.test('secondary assignment and a later return to the same person split first and rework once per handoff', async () => {
      const initial = await activity();
      const initialA = await activity(DAY, [annotator(a)]);
      const initialB = await activity(DAY, [annotator(b)]);
      const initialBeforeA = await activity(BEFORE, [annotator(a)]);
      const initialBeforeB = await activity(BEFORE, [annotator(b)]);
      const fixture = await task('甲旧提交、乙二次分配后首次与后续、甲接回');
      const session = randomUUID();
      const assessmentId = await human(fixture, 'COPY', 'APPROVE', at(BEFORE, '08:00:00'), { session });
      await copyApproval(fixture, at(BEFORE, '08:00:00'), { session, assessmentId });
      const oldRevisionId = fixture.copyRevisionId;
      await archive(fixture);
      assert.equal(Number((await db.query('SELECT count(*) FROM human_quality_assessments WHERE task_id=$1',
        [fixture.taskId])).rows[0].count), 0);
      await db.query(`UPDATE tasks SET state='PENDING_SECOND_ASSIGNMENT',current_stage='PENDING_SECOND_ASSIGNMENT',
        copy_qa_rework_pending=false,mandatory_copy_qc=true,mandatory_copy_qc_origin='SECOND_ASSIGNMENT'
        WHERE id=$1`, [fixture.taskId]);
      await reassign(fixture, null, at(BEFORE, '18:00:00'));
      const resetId = await revision(fixture, { origin: 'SECOND_ASSIGNMENT_RESET', parentId: oldRevisionId });
      await db.query(`UPDATE tasks SET state='COPY_REVIEW_PENDING',current_stage='COPY_REVIEW_PENDING',
        copy_qa_cycle=copy_qa_cycle+1 WHERE id=$1`, [fixture.taskId]);
      await reassign(fixture, b, at(DAY, '06:00:00'));
      const firstBId = await revision(fixture, { origin: 'COPY_EDIT', parentId: resetId, rework: true });
      await copyApproval(fixture, at(DAY, '08:00:00'));
      const laterBId = await revision(fixture, { origin: 'COPY_EDIT', parentId: firstBId, rework: false });
      await copyApproval(fixture, at(DAY, '10:00:00'));
      await reassign(fixture, a, at(DAY, '12:00:00'));
      await revision(fixture, { origin: 'COPY_EDIT', parentId: laterBId, rework: true });
      await copyApproval(fixture, at(DAY, '14:00:00'));

      const current = await activity();
      assert.deepEqual(difference(current, initial), { ...ZERO, copyReview: 2, copyRework: 1 },
        'the first workflow rework is only personal first, and the later unflagged submit is only personal rework');
      assert.equal(current.copyReview - initial.copyReview + current.copyRework - initial.copyRework, 3,
        'three valid period submissions occupy exactly one first or rework metric each');
      assert.deepEqual(difference(await activity(DAY, [annotator(a)]), initialA), { ...ZERO, copyReview: 1 });
      assert.deepEqual(difference(await activity(DAY, [annotator(b)]), initialB),
        { ...ZERO, copyReview: 1, copyRework: 1 });
      assert.deepEqual(difference(await activity(BEFORE, [annotator(a)]), initialBeforeA),
        { ...ZERO, copyReview: 1 }, 'the old first remains on its original operation day despite reset and archives');
      assert.deepEqual(difference(await activity(BEFORE, [annotator(b)]), initialBeforeB), ZERO,
        'filtering the new owner does not pull the previous owner first into that owner period');
    });

    await t.test('COPY first work belongs to the actual MANUAL submitter rather than historical or current task owners', async () => {
      const initial = await activity();
      const initialAdmin = await activity(DAY, [annotator(admin)]);
      const initialA = await activity(DAY, [annotator(a)]);
      const initialB = await activity(DAY, [annotator(b)]);
      const fixture = await task('负责人为甲、实际人工提交为管理员、查询时改派乙');
      await copyApproval(fixture, at(DAY, '15:00:00'), { actor: admin, mode: 'MANUAL' });
      await reassign(fixture, b, at(AFTER, '09:00:00'));

      assert.deepEqual(difference(await activity(), initial), { ...ZERO, copyReview: 1 });
      assert.deepEqual(difference(await activity(DAY, [annotator(admin)]), initialAdmin),
        { ...ZERO, copyReview: 1 }, 'MANUAL actor identity is authoritative even while the historical owner is someone else');
      assert.deepEqual(difference(await activity(DAY, [annotator(a)]), initialA), ZERO,
        'the historical assignee cannot acquire another account submission');
      assert.deepEqual(difference(await activity(DAY, [annotator(b)]), initialB), ZERO,
        'the current assignee cannot acquire an earlier submission');
    });
  } finally {
    await repository.close();
    await database.stop();
  }
});
