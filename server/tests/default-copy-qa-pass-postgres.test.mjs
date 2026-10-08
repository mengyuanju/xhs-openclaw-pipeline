import assert from 'node:assert/strict';
import test from 'node:test';

import { routeCopyApprovalV2 } from '../src/copy-qa-v2.mjs';
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
        "SELECT state,current_copy_revision_id,copy_qc_released_revision_id,copy_qa_auto_passed_revision_id,mandatory_copy_qc,copy_quality_image_eligible(id,current_copy_revision_id,mandatory_copy_qc) AS image_eligible FROM tasks WHERE id=$1",
        [task.id],
      )).rows[0];
      assert.equal(result.state, 'IMAGE_QUEUED');
      assert.equal(Number(result.copy_qc_released_revision_id), Number(revision.id));
      assert.equal(Number(result.copy_qa_auto_passed_revision_id), Number(revision.id));
      assert.equal(result.mandatory_copy_qc, false);
      assert.equal(result.image_eligible, true);
      const report = await readTaskDataReportTask(repository.pool, { role: 'ADMIN', userId: 1 }, task.id);
      assert.equal(report.item.copyStatus, 'QA_RELEASED');
      assert.equal(report.item.copyQaStatus, 'SYSTEM_PASSED');
      assert.equal(report.item.copyQaReleaseMode, 'ACCOUNT_AUTO_PASS');
      assert.equal(report.item.copyQaHumanPassedAt, null);
      assert.equal(Number((await repository.pool.query(
        'SELECT count(*) AS count FROM copy_qa_batch_members_v2 WHERE task_id=$1', [task.id],
      )).rows[0].count), 0);
    }
  } finally {
    await repository.close();
    await database.stop();
  }
});
