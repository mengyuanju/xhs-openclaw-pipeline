import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { routeCopyApprovalV2 } from '../src/copy-qa-v2.mjs';
import { applyMigrations, loadMigrations, migrateDatabase } from '../src/database-migrations.mjs';
import { readTaskDataReportTask } from '../src/task-data-report.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { startTemporaryPostgres18 } from './helpers/personal-postgres.mjs';

test('PostgreSQL: per-user system QA pass skips sampling and enters image queue', {
  skip: process.env.RUN_POSTGRES_E2E !== '1', timeout: 180_000,
}, async () => {
  const database = await startTemporaryPostgres18();
  const repository = new PostgresControlPlaneRepository({ connectionString: database.connectionString });
  try {
    await repository.initialize();
    await repository.pool.query("INSERT INTO executor_nodes(id,name) VALUES('auto-pass-node','Auto Pass Test')");
    const user = await repository.createUser({
      username: 'auto-pass-worker', displayName: '自动通过账号', role: 'USER',
      defaultCopyQaPass: true, copySamplingRateBpsOverride: 10000,
      autoCopyBatchEnabled: true, autoCopyBatchSize: 1, copyFullInspection: true,
    });
    assert.equal(user.defaultCopyQaPass, true);
    for (const mandatory of [false, true]) {
      const task = (await repository.pool.query(
        "INSERT INTO tasks(query,input,state,created_by_node_id,assigned_to_user_id,assignment_source,assigned_at,mandatory_copy_qc,mandatory_copy_qc_origin) VALUES('自动通过测试','{}','COPY_REVIEW_PENDING','auto-pass-node',$1,'MANUAL',now(),$2,$3) RETURNING *",
        [user.username, mandatory, mandatory ? 'QA_RETURN' : null],
      )).rows[0];
      const revision = (await repository.pool.query(
        "INSERT INTO copy_revisions(task_id,revision,content,revision_origin,approved_at) VALUES($1,1,$2,'GENERATION',now()) RETURNING *",
        [task.id, { copy: { title: '测试文案', body: '待质检文案', tags: ['#测试'] }, imagePlan: [] }],
      )).rows[0];
      await repository.pool.query('UPDATE tasks SET current_copy_revision_id=$2 WHERE id=$1', [task.id, revision.id]);
      const approval = (await repository.pool.query(
        "INSERT INTO copy_approval_events(task_id,copy_revision_id,approval_mode,approved_by_account_id,approved_by_username,content_sha256) VALUES($1,$2,'MANUAL',$3,$4,$5) RETURNING *",
        [task.id, revision.id, user.id, user.username, 'a'.repeat(64)],
      )).rows[0];
      const client = await repository.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("UPDATE workflow_quality_settings SET copy_sampling_enabled=true,copy_sampling_rate_bps=10000");
        await routeCopyApprovalV2(client, { task, revision, approval,
          actor: { userId: user.id }, aiDisclosureEnabled: true });
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      const result = (await repository.pool.query(
        "SELECT state,current_copy_revision_id,copy_qc_released_revision_id,mandatory_copy_qc,copy_quality_image_eligible(id,current_copy_revision_id,mandatory_copy_qc) AS image_eligible FROM tasks WHERE id=$1",
        [task.id],
      )).rows[0];
      assert.equal(result.state, 'IMAGE_QUEUED');
      assert.equal(Number(result.copy_qc_released_revision_id), Number(revision.id));
      assert.equal(result.mandatory_copy_qc, false);
      assert.equal(result.image_eligible, true);
      const inspections = (await repository.pool.query(`SELECT qa_method,decision_mode,passed,verdict,
        reviewer_account_id,approval_event_id FROM copy_qa_inspection_records
        WHERE task_id=$1 AND copy_revision_id=$2`, [task.id, revision.id])).rows;
      assert.equal(inspections.length, 1);
      assert.deepEqual({ method: inspections[0].qa_method, passed: inspections[0].passed,
        mode: inspections[0].decision_mode, verdict: inspections[0].verdict,
        reviewerAccountId: inspections[0].reviewer_account_id,
        approvalEventId: Number(inspections[0].approval_event_id) },
      { method: 'SYSTEM', mode: 'ACCOUNT_DEFAULT', passed: true, verdict: 'PASS', reviewerAccountId: null,
        approvalEventId: Number(approval.id) });
      const listed = await repository.listTasks({ taskIds: [Number(task.id)] });
      assert.equal(listed.length, 1);
      assert.equal(listed[0].copyQaAutoPassed, true);
      assert.equal(listed[0].copyQaPassMode, 'ACCOUNT_DEFAULT');
      const detail = await repository.getTask(task.id, { historyMode: 'current' });
      assert.equal(detail.copyQaAutoPassed, true);
      const report = await readTaskDataReportTask(repository.pool, { role: 'ADMIN', userId: 1 }, task.id);
      assert.equal(report.item.copyStatus, 'QA_RELEASED');
      assert.equal(report.item.copyQaStatus, 'SYSTEM_PASSED');
      assert.equal(report.item.copyQaReleaseMode, 'ACCOUNT_AUTO_PASS');
      assert.equal(report.item.copyQaHumanPassedAt, null);
      assert.equal(Number((await repository.pool.query(
        'SELECT count(*) AS count FROM copy_qa_batch_members_v2 WHERE task_id=$1', [task.id],
      )).rows[0].count), 0);
      await repository.pool.query('UPDATE tasks SET copy_qc_released_revision_id=NULL WHERE id=$1', [task.id]);
      const revoked = await repository.listTasks({ taskIds: [Number(task.id)] });
      assert.equal(revoked[0].copyQaAutoPassed, false);
      assert.equal(revoked[0].copyQaPassMode, null);
    }
  } finally {
    await repository.close();
    await database.stop();
  }
});

test('PostgreSQL: historical and live batch releases get distinct passing records', {
  skip: process.env.RUN_POSTGRES_E2E !== '1', timeout: 180_000,
}, async () => {
  const database = await startTemporaryPostgres18();
  const repository = new PostgresControlPlaneRepository({ connectionString: database.connectionString });
  const db = repository.pool;
  try {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await applyMigrations(client, (await loadMigrations()).filter(({ id }) => id < '0118_copy_qa_batch_release_records'));
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    await db.query("INSERT INTO executor_nodes(id,name) VALUES('release-history-node','Release History')");
    const accountId = Number((await db.query(`INSERT INTO app_users(username,display_name,role,password_hash,status)
      VALUES('release-history-user','Release History','USER','test-only','ACTIVE') RETURNING id`)).rows[0].id);
    const productionBatchId = Number((await db.query(`INSERT INTO production_batches(
      public_id,query_package_name,created_by_username,request_id,request_fingerprint,client_batch_code)
      VALUES($1,'历史批次','release-history-user',$2,$3,$4) RETURNING id`,
    [randomUUID(), randomUUID(), 'a'.repeat(64), 'b'.repeat(32)])).rows[0].id);
    const freezeId = Number((await db.query(`INSERT INTO copy_sampling_freezes(
      public_id,production_batch_id,policy_version,rate_bps,seed,algorithm_version,
      blind_review_enabled,population_count,sample_count,snapshot_sha256,
      frozen_by_username,request_id,request_fingerprint,status,resolved_at)
      VALUES($1,$2,1,0,'test','test',false,2,0,$3,
      'release-history-user',$4,$3,'RELEASED',now()) RETURNING id`,
    [randomUUID(),productionBatchId,'c'.repeat(64),randomUUID()])).rows[0].id);
    const v2BatchId = Number((await db.query(`INSERT INTO copy_qa_batches_v2(
      mode,account_id,return_threshold_bps,return_trigger_count,member_count,sample_count,
      status,completed_at)
      VALUES('PERSONAL_MANUAL',$1,10000,1,1,0,'COMPLETED',now()) RETURNING id`,
    [accountId])).rows[0].id);
    async function releaseFixture(kind, status) {
      const taskId = Number((await db.query(`INSERT INTO tasks(query,input,state,created_by_node_id,
        production_batch_id) VALUES('历史批次放行','{}','IMAGE_QUEUED','release-history-node',$1)
        RETURNING id`,[productionBatchId])).rows[0].id);
      const revisionId = Number((await db.query(`INSERT INTO copy_revisions(task_id,revision,content,
        revision_origin) VALUES($1,1,'{}','GENERATION') RETURNING id`,[taskId])).rows[0].id);
      const approvalId = Number((await db.query(`INSERT INTO copy_approval_events(task_id,
        copy_revision_id,approval_mode,approved_by_account_id,approved_by_username,content_sha256)
        VALUES($1,$2,'MANUAL',$3,'release-history-user',$4) RETURNING id`,
      [taskId,revisionId,accountId,'d'.repeat(64)])).rows[0].id);
      await db.query(`UPDATE tasks SET current_copy_revision_id=$2,
        copy_qc_released_revision_id=$2 WHERE id=$1`,[taskId,revisionId]);
      let sourceKey;
      if (kind === 'v2') {
        const memberId = Number((await db.query(`INSERT INTO copy_qa_batch_members_v2(
          batch_id,task_id,copy_revision_id,approval_event_id,approver_account_id,
          quality_cycle,content_sha256,selected,status)
          VALUES($1,$2,$3,$4,$5,1,$6,false,$7) RETURNING id`,
        [v2BatchId,taskId,revisionId,approvalId,accountId,'e'.repeat(64),status])).rows[0].id);
        sourceKey = `v2:${memberId}`;
      } else {
        const itemId = Number((await db.query(`INSERT INTO copy_sampling_items(
          public_id,freeze_id,task_id,approval_event_id,copy_revision_id,content_sha256,
          final_approver_account_id,final_approver_username,rank_hash,selected,status)
          VALUES($1,$2,$3,$4,$5,$6,$7,'release-history-user',$6,$8,$9) RETURNING id`,
        [randomUUID(),freezeId,taskId,approvalId,revisionId,'f'.repeat(64),accountId,
          status === 'PASSED',status])).rows[0].id);
        sourceKey = `legacy:${itemId}`;
      }
      return {taskId,sourceKey,approvalId,revisionId};
    }
    const historicalV2 = await releaseFixture('v2','RELEASED');
    const historicalLegacy = await releaseFixture('legacy','RELEASED');
    const historicalDirect = await releaseFixture('legacy','PASSED');
    async function markAdminDirect(fixture) {
      await db.query(`INSERT INTO copy_qa_admin_direct_approvals(task_id,copy_revision_id,
        approval_event_id,actor_account_id,actor_username,request_id)
        VALUES($1,$2,$3,$4,'release-history-user',$5)`,
      [fixture.taskId,fixture.revisionId,fixture.approvalId,accountId,randomUUID()]);
    }
    await markAdminDirect(historicalDirect);
    await migrateDatabase(db);
    const liveLegacy = await releaseFixture('legacy','NOT_SELECTED');
    await db.query("UPDATE copy_sampling_items SET status='RELEASED' WHERE id=$1",
      [Number(liveLegacy.sourceKey.slice('legacy:'.length))]);
    const liveDirect = await releaseFixture('legacy','PASSED');
    await markAdminDirect(liveDirect);
    for (const fixture of [historicalV2,historicalLegacy,liveLegacy]) {
      const records = (await db.query(`SELECT qa_method,decision_mode,passed,verdict
        FROM copy_qa_inspection_records WHERE source_key=$1`,[fixture.sourceKey])).rows;
      assert.deepEqual(records,[{qa_method:'SYSTEM',decision_mode:'BATCH_RELEASE',
        passed:true,verdict:'PASS'}]);
      const task = (await repository.listTasks({taskIds:[fixture.taskId]}))[0];
      assert.equal(task.copyQaPassMode,'BATCH_RELEASE');
      assert.equal(task.copyQaAutoPassed,false);
    }
    for (const fixture of [historicalDirect,liveDirect]) {
      const record = (await db.query(`SELECT qa_method,decision_mode,passed,verdict
        FROM copy_qa_inspection_records WHERE source_key=$1`,[fixture.sourceKey])).rows[0];
      assert.deepEqual(record,{qa_method:'HUMAN',decision_mode:'ADMIN_DIRECT',
        passed:true,verdict:'PASS'});
      assert.equal((await repository.listTasks({taskIds:[fixture.taskId]}))[0].copyQaPassMode,
        'ADMIN_DIRECT');
    }
  } finally {
    await repository.close();
    await database.stop();
  }
});

test('PostgreSQL: existing system passes become inspection records during migration', {
  skip: process.env.RUN_POSTGRES_E2E !== '1', timeout: 180_000,
}, async () => {
  const database = await startTemporaryPostgres18();
  const repository = new PostgresControlPlaneRepository({ connectionString: database.connectionString });
  try {
    const client = await repository.pool.connect();
    try {
      await client.query('BEGIN');
      await applyMigrations(client, (await loadMigrations()).filter(({ id }) => id < '0117_copy_qa_inspection_records'));
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    await repository.pool.query("INSERT INTO executor_nodes(id,name) VALUES('qa-history-node','QA History Test')");
    const task = (await repository.pool.query(`INSERT INTO tasks(query,input,state,created_by_node_id)
      VALUES('历史系统质检','{}','COPY_REVIEW_PENDING','qa-history-node') RETURNING id`)).rows[0];
    const revision = (await repository.pool.query(`INSERT INTO copy_revisions(task_id,revision,content,revision_origin)
      VALUES($1,1,$2,'GENERATION') RETURNING id`, [task.id,
      { copy: { title: '历史文案', body: '历史正文', tags: [] }, imagePlan: [] }])).rows[0];
    await repository.pool.query(`UPDATE tasks SET state='IMAGE_QUEUED',current_stage='IMAGE_QUEUED',
      current_copy_revision_id=$2,
      copy_qc_released_revision_id=$2,copy_qa_auto_passed_revision_id=$2 WHERE id=$1`,
    [task.id, revision.id]);
    await migrateDatabase(repository.pool);
    const record = (await repository.pool.query(`SELECT qa_method,decision_mode,passed,verdict
      FROM copy_qa_inspection_records WHERE task_id=$1 AND copy_revision_id=$2`,
    [task.id, revision.id])).rows[0];
    assert.deepEqual(record, { qa_method: 'SYSTEM', decision_mode: 'ACCOUNT_DEFAULT',
      passed: true, verdict: 'PASS' });
    const listed = await repository.listTasks({ taskIds: [Number(task.id)] });
    assert.equal(listed[0].copyQaAutoPassed, true);
  } finally {
    await repository.close();
    await database.stop();
  }
});
