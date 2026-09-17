import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import pg from 'pg';

import { copyQualityImageGate } from '../src/copy-quality-flow.mjs';
import { passCopyQaItem, routeManualCopyApproval } from '../src/copy-quality-control.mjs';
import { applyMigrations, loadMigrations } from '../src/database-migrations.mjs';
import { startTemporaryPostgres18 } from './temporary-postgres18.mjs';

const RUN_POSTGRES_E2E = process.env.RUN_POSTGRES_E2E === '1';

test('0067 repairs image-plan revisions stranded behind copy mandatory recheck', {
  skip: !RUN_POSTGRES_E2E,
}, async t => {
  const postgres = await startTemporaryPostgres18('xhs-copy-qc-inheritance-pg18-');
  const pool = new pg.Pool({ connectionString: postgres.connectionString, max: 4 });
  t.after(async () => {
    await pool.end();
    await postgres.stop();
  });

  const migrations = await loadMigrations();
  const inheritanceMigration = migrations.find(entry => entry.id === '0067_image_plan_copy_qc_inheritance');
  assert.ok(inheritanceMigration);
  const beforeInheritance = migrations.filter(entry => entry.id < inheritanceMigration.id);
  const throughInheritance = migrations.filter(entry => entry.id <= inheritanceMigration.id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await applyMigrations(client, beforeInheritance);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  await pool.query("INSERT INTO executor_nodes(id, name) VALUES ('qc-inheritance', 'QC inheritance')");
  const users = [];
  for (const username of ['author', 'inspector']) {
    users.push((await pool.query(`INSERT INTO app_users(
        username, display_name, role, password_hash, copy_qc_enabled
      ) VALUES ($1, $1, 'REVIEWER', 'not-a-credential', true) RETURNING *`, [username])).rows[0]);
  }
  const author = { userId: Number(users[0].id), username: 'author', role: 'REVIEWER', credentialVersion: 1 };
  const inspector = { userId: Number(users[1].id), username: 'inspector', role: 'REVIEWER', credentialVersion: 1 };
  await pool.query('UPDATE workflow_quality_settings SET copy_sampling_enabled = true, copy_sampling_rate_bps = 10000');
  const batch = (await pool.query(`INSERT INTO production_batches(
      public_id, client_batch_code, query_package_name,
      created_by_username, request_id, request_fingerprint
    ) VALUES ($1, '22222222222222222222222222222222', 'inheritance-test',
      'author', $2, $3) RETURNING *`, [randomUUID(), randomUUID(), '0'.repeat(64)])).rows[0];
  const task = (await pool.query(`INSERT INTO tasks(
      query, created_by_node_id, copy_executor_node_id, state,
      production_batch_id, assigned_to_user_id, assignment_source, assigned_at
    ) VALUES ('image plan retry', 'qc-inheritance', 'qc-inheritance', 'COPY_RUNNING',
      $1, 'author', 'MANUAL', now()) RETURNING *`, [batch.id])).rows[0];
  const sourceContent = {
    copy: { title: '保持不变的标题', body: '保持不变的正文', tags: ['#测试'] },
    imagePlan: [{ kind: 'hero', headline: '原规划', subtitle: '', bullets: ['一', '二'], prompt: '原图片规划' }],
  };
  const source = (await pool.query(`INSERT INTO copy_revisions(
      task_id, revision, content, approved_at, revision_origin, approval_mode
    ) VALUES ($1, 1, $2, now(), 'COPY_EDIT', 'MANUAL') RETURNING *`,
  [task.id, sourceContent])).rows[0];
  await pool.query(`UPDATE tasks SET current_copy_revision_id = $2,
    state = 'COPY_REVIEW_PENDING', current_stage = 'COPY_REVIEW_PENDING' WHERE id = $1`,
  [task.id, source.id]);
  await pool.query(`INSERT INTO production_batch_items(production_batch_id, task_id, query_snapshot)
    VALUES ($1, $2, 'image plan retry')`, [batch.id, task.id]);

  const taskForApproval = (await pool.query('SELECT * FROM tasks WHERE id = $1', [task.id])).rows[0];
  const approvalClient = await pool.connect();
  try {
    await approvalClient.query('BEGIN');
    await routeManualCopyApproval(approvalClient, {
      task: taskForApproval,
      revision: source,
      assessment: null,
      actor: author,
      reviewSessionId: randomUUID(),
      aiDisclosureEnabled: false,
    });
    await approvalClient.query('COMMIT');
  } catch (error) {
    await approvalClient.query('ROLLBACK');
    throw error;
  } finally {
    approvalClient.release();
  }
  const pendingItem = (await pool.query(`SELECT * FROM copy_sampling_items
    WHERE task_id = $1 AND copy_revision_id = $2 AND selected = true
    ORDER BY id DESC LIMIT 1`, [task.id, source.id])).rows[0];
  assert.ok(pendingItem);
  await passCopyQaItem(pool, pendingItem.public_id, {
    requestId: randomUUID(),
    expectedCopyRevisionId: Number(source.id),
  }, inspector);
  await pool.query(`UPDATE tasks SET state = 'MANUAL_ARCHIVE', current_stage = 'MANUAL_ARCHIVE'
    WHERE id = $1`, [task.id]);

  const targetContent = {
    ...sourceContent,
    imagePlan: [{ kind: 'hero', headline: '修正规划', subtitle: '', bullets: ['一', '二'], prompt: '修正图片规划' }],
    imageRevision: {
      version: 1,
      operation: 'REGENERATE',
      planEdited: true,
      baseRevisionId: Number(source.id),
      baseImageRunId: randomUUID(),
      actorUsername: 'inspector',
      createdAt: new Date().toISOString(),
    },
  };
  const target = (await pool.query(`INSERT INTO copy_revisions(
      task_id, revision, parent_revision_id, content, approved_at,
      revision_origin, approval_mode
    ) VALUES ($1, 2, $2, $3, now(), 'PLAN_EDIT', 'MANUAL') RETURNING *`,
  [task.id, source.id, targetContent])).rows[0];
  const broken = (await pool.query(`UPDATE tasks SET state = 'IMAGE_QUEUED',
      current_stage = 'IMAGE_QUEUED', current_copy_revision_id = $2
    WHERE id = $1 RETURNING *`, [task.id, target.id])).rows[0];
  assert.equal(broken.state, 'COPY_REVIEW_PENDING');
  assert.equal(broken.mandatory_copy_qc, true);
  assert.equal((await pool.query('SELECT status FROM copy_sampling_items WHERE id = $1',
    [pendingItem.id])).rows[0].status, 'SUPERSEDED');

  const migrationClient = await pool.connect();
  try {
    await migrationClient.query('BEGIN');
    assert.deepEqual(await applyMigrations(migrationClient, throughInheritance), [inheritanceMigration.id]);
    await migrationClient.query('COMMIT');
  } catch (error) {
    await migrationClient.query('ROLLBACK');
    throw error;
  } finally {
    migrationClient.release();
  }

  const repaired = (await pool.query('SELECT * FROM tasks WHERE id = $1', [task.id])).rows[0];
  assert.equal(repaired.state, 'IMAGE_QUEUED');
  assert.equal(repaired.current_stage, 'IMAGE_QUEUED');
  assert.equal(repaired.mandatory_copy_qc, false);
  assert.equal(repaired.mandatory_copy_qc_origin, null);
  assert.equal(Number(repaired.copy_qc_released_revision_id), Number(target.id));
  assert.equal((await pool.query('SELECT status FROM copy_sampling_items WHERE id = $1',
    [pendingItem.id])).rows[0].status, 'PASSED');
  assert.equal(Number((await pool.query(
    'SELECT count(*) FROM copy_qc_revision_inheritances WHERE target_revision_id = $1 AND source_revision_id = $2',
    [target.id, source.id],
  )).rows[0].count), 1);
  assert.equal((await pool.query(
    `SELECT ${copyQualityImageGate('task')} AS ok FROM tasks task WHERE id = $1`,
    [task.id],
  )).rows[0].ok, true);
  await pool.query('DELETE FROM tasks WHERE id = $1', [task.id]);
  assert.equal(Number((await pool.query(
    'SELECT count(*) FROM copy_qc_revision_inheritances WHERE task_id = $1',
    [task.id],
  )).rows[0].count), 0);
});
