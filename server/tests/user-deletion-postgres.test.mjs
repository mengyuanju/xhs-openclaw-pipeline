import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import pg from 'pg';

import { applyMigrations, loadMigrations } from '../src/database-migrations.mjs';
import { createControlPlaneApp } from '../src/http-server.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { startTemporaryPostgres18 } from './temporary-postgres18.mjs';

const HISTORY_COLUMNS = [
  ['image_approval_events', 'submitted_by_account_id'],
  ['image_sampling_freezes', 'submitter_account_id'],
  ['image_sampling_items', 'submitter_account_id'],
  ['image_sampling_remainders', 'submitter_account_id'],
  ['copy_image_plan_regeneration_jobs', 'requested_by_account_id'],
  ['standalone_image_workspaces', 'owner_id'],
];
const content = {
  copy: { title: '测试历史身份', body: '测试数据。'.repeat(80), tags: ['#测试数据', '#历史身份', '#账号管理'] },
  imagePlan: [
    { kind: 'hero', headline: '测试标题', subtitle: '', bullets: ['测试要点', '测试说明'], prompt: '用于回归测试的历史图片规划' },
    { kind: 'steps', headline: '测试步骤', subtitle: '', bullets: ['测试步骤', '测试说明'], prompt: '用于回归测试的历史图片规划' },
    { kind: 'summary', headline: '测试结尾', subtitle: '', bullets: ['测试结尾', '测试说明'], prompt: '用于回归测试的历史图片规划' },
  ],
};

function actorHeaders(actor) {
  return {
    'X-Actor-User-Id': String(actor.userId),
    'X-Actor-Username': actor.username,
    'X-Actor-Role': actor.role,
    'X-Actor-Credential-Version': String(actor.credentialVersion),
    'content-type': 'application/json',
  };
}

async function migrate(pool, migrations) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const applied = await applyMigrations(client, migrations);
    await client.query('COMMIT');
    return applied;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

test('PostgreSQL user deletion upgrades historical identities without losing data or transferring ownership', {
  skip: process.env.RUN_POSTGRES_E2E !== '1', timeout: 180_000,
}, async t => {
  const postgres = await startTemporaryPostgres18('xhs-user-deletion-');
  const storageRoot = await mkdtemp(join(tmpdir(), 'xhs-user-deletion-storage-'));
  const pool = new pg.Pool({ connectionString: postgres.connectionString });
  // This fixture deliberately keeps the 0098 account foreign keys until the
  // upgrade below. Delegate every repository query/transaction to real PG,
  // without enabling current-schema maintenance workers (0100 and later).
  const repository = new PostgresControlPlaneRepository({ pool: {
    query: pool.query.bind(pool),
    connect: pool.connect.bind(pool),
  } });
  let server;
  let app;
  try {
    const migrations = await loadMigrations();
    const oldMigrations = migrations.filter(({ id }) => id < '0099');
    assert.ok(oldMigrations.some(({ id }) => id === '0098_image_rework_quality_facts'));
    await migrate(pool, oldMigrations);
    await pool.query("INSERT INTO executor_nodes(id,name) VALUES('user-deletion-test','test only')");

    async function createUser(username, role = 'USER') {
      const row = (await pool.query(`INSERT INTO app_users(username,display_name,role,password_hash,
        must_change_password,copy_review_enabled) VALUES($1,$1,$2,'test-only',false,true)
        RETURNING id,username,role,credential_version`, [username, role])).rows[0];
      return { userId: Number(row.id), username: row.username, role: row.role,
        credentialVersion: Number(row.credential_version) };
    }
    const admin = await createUser('deletion-admin', 'ADMIN');
    const victims = [];
    const batchId = (await pool.query(`INSERT INTO production_batches(public_id,query_package_name,
      created_by_account_id,created_by_username,request_id,request_fingerprint,client_batch_code)
      VALUES($1,'deletion history',$2,$3,$4,$5,$6) RETURNING id`,
    [randomUUID(), admin.userId, admin.username, randomUUID(), 'a'.repeat(64), 'b'.repeat(32)])).rows[0].id;

    async function imageFixture(actor, { state = 'CANCELLED', standalone = false } = {}) {
      const taskId = (await pool.query(`INSERT INTO tasks(query,input,state,task_kind,created_by_node_id,
        created_by_user_id,assigned_to_user_id,assignment_source,assigned_at)
        VALUES('user deletion fixture','{}',$1,$2,'user-deletion-test',$3,$3,'MANUAL',now()) RETURNING id`,
      [state, standalone ? 'STANDALONE_IMAGE_EDIT' : 'CONTENT', actor.username])).rows[0].id;
      const revisionId = (await pool.query(`INSERT INTO copy_revisions(task_id,revision,content,revision_origin)
        VALUES($1,1,$2,'GENERATION') RETURNING id`, [taskId, content])).rows[0].id;
      const runId = randomUUID();
      await pool.query(`INSERT INTO image_runs(id,task_id,copy_revision_id,status,result,image_production_chain_id)
        VALUES($1,$2,$3,'COMPLETED','{}',$1)`, [runId, taskId, revisionId]);
      await pool.query('UPDATE tasks SET current_copy_revision_id=$2,current_image_run_id=$3 WHERE id=$1',
        [taskId, revisionId, runId]);
      return { taskId, revisionId, runId };
    }
    async function approval(fixture, submitter) {
      return (await pool.query(`INSERT INTO image_approval_events(task_id,copy_revision_id,image_run_id,
        submitted_by_account_id,submitted_by_username,review_session_id,image_set_sha256)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [fixture.taskId, fixture.revisionId, fixture.runId, submitter.userId, submitter.username,
        randomUUID(), 'c'.repeat(64)])).rows[0].id;
    }
    async function freeze(submitter, { version = 1, sampleCount = 0 } = {}) {
      return (await pool.query(`INSERT INTO image_sampling_freezes(public_id,production_batch_id,
        freeze_version,policy_version,rate_bps,seed,algorithm_version,blind_review_enabled,
        submitter_account_id,population_count,sample_count,snapshot_sha256,frozen_by_account_id,
        frozen_by_username,request_id,close_reason,status)
        VALUES($1,$2,$3,1,10000,'test','test',false,$4,1,$5,$6,$7,$8,$9,'MANUAL','RELEASED') RETURNING id`,
      [randomUUID(), batchId, version, submitter.userId, sampleCount, 'd'.repeat(64), admin.userId,
        admin.username, randomUUID()])).rows[0].id;
    }
    async function workspace(fixture, owner, status = 'ACCEPTED') {
      const requestId = randomUUID();
      await pool.query(`INSERT INTO standalone_image_workspaces(task_id,owner_id,request_id,upload_hash,title,limits)
        VALUES($1,$2,$3,$4,'historical upload','{}')`,
      [fixture.taskId, owner.userId, requestId, 'e'.repeat(64)]);
      const assetId = (await pool.query(`INSERT INTO assets(task_id,image_run_id,media_type,byte_size,
        sha256,storage_path,image_production_chain_id,origin_image_run_id,artifact_key)
        VALUES($1,$2,'image/png',1,$3,$4,$2,$2,'test-only') RETURNING id`,
      [fixture.taskId, fixture.runId, 'f'.repeat(64),
        join(storageRoot, String(fixture.taskId), 'test-only-never-read.png')])).rows[0].id;
      await pool.query(`INSERT INTO image_edit_requests(id,task_id,request_id,source_image_run_id,
        source_asset_id,copy_revision_id,source_sha256,target_page,operation,config,status,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,1,'TEXT','{}',$8,$9)`,
      [randomUUID(), fixture.taskId, randomUUID(), fixture.runId, assetId, fixture.revisionId,
        'f'.repeat(64), status, owner.username]);
      return requestId;
    }
    async function queryAssignment(actor) {
      const packageId = (await pool.query(`INSERT INTO query_packages(name,created_by_username,
        assigned_to_account_id,assigned_to_username,client_batch_code) VALUES($1,$2,$3,$1,$4) RETURNING id`,
      [actor.username, admin.username, actor.userId, randomUUID().replaceAll('-', '')])).rows[0].id;
      await pool.query(`INSERT INTO query_package_items(query_package_id,row_number,raw_query,
        screening_assigned_to_account_id,screening_assigned_to_username,
        screening_assigned_by_account_id,screening_assigned_by_username,screening_assigned_at)
        VALUES($1,1,'test query',$2,$3,$4,$5,now())`,
      [packageId, actor.userId, actor.username, admin.userId, admin.username]);
      return packageId;
    }

    for (const [table, column] of HISTORY_COLUMNS.filter(([table]) => table !== 'image_sampling_remainders')) {
      const actor = await createUser(`deletion-${victims.length}`);
      const fixture = await imageFixture(actor, { standalone: table === 'standalone_image_workspaces',
        state: table === 'standalone_image_workspaces' ? 'MANUAL_ARCHIVE' : 'CANCELLED' });
      const victim = { actor, table, column, ...fixture, packageId: await queryAssignment(actor) };
      if (table === 'image_approval_events') victim.approvalId = await approval(fixture, actor);
      if (table === 'image_sampling_freezes') victim.freezeId = await freeze(actor);
      if (table === 'image_sampling_items') {
        const approvalId = await approval(fixture, admin);
        const freezeId = await freeze(admin, { sampleCount: 1 });
        victim.itemId = (await pool.query(`INSERT INTO image_sampling_items(public_id,freeze_id,task_id,
          approval_event_id,copy_revision_id,image_run_id,image_set_sha256,submitter_account_id,
          submitter_username,rank_hash,selected,status,reviewed_by_account_id,reviewed_by_username,reviewed_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$7,true,'PASSED',$10,$11,now()) RETURNING id`,
        [randomUUID(), freezeId, fixture.taskId, approvalId, fixture.revisionId, fixture.runId,
          'c'.repeat(64), actor.userId, actor.username, admin.userId, admin.username])).rows[0].id;
      }
      if (table === 'copy_image_plan_regeneration_jobs') {
        victim.jobId = randomUUID();
        victim.requestId = randomUUID();
        await pool.query(`INSERT INTO copy_image_plan_regeneration_jobs(id,request_id,task_id,
          copy_revision_id,requested_by_account_id,requested_by_username,copy_payload,status,result,finished_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,'SUCCEEDED',$8,now())`,
        [victim.jobId, victim.requestId, fixture.taskId, fixture.revisionId, actor.userId,
          actor.username, content.copy, { imagePlan: content.imagePlan }]);
      }
      if (table === 'standalone_image_workspaces') victim.requestId = await workspace(fixture, actor);
      await pool.query(`INSERT INTO image_sampling_remainders(production_batch_id,submitter_account_id,remainder_bps)
        VALUES($1,$2,4321)`, [batchId, actor.userId]);
      victims.push(victim);
    }

    const snapshotTables = ['app_users', 'tasks', 'task_assignment_events', 'query_packages', 'query_package_items',
      'image_approval_events', 'image_sampling_freezes', 'image_sampling_items', 'image_sampling_remainders',
      'copy_image_plan_regeneration_jobs', 'standalone_image_workspaces', 'image_edit_requests', 'assets'];
    async function snapshot(tables = snapshotTables) {
      const entries = [];
      for (const table of tables) {
        entries.push([table, (await pool.query(`SELECT * FROM ${table} ORDER BY to_jsonb(${table})::text`)).rows]);
      }
      return Object.fromEntries(entries);
    }
    const foreignKeys = async () => (await pool.query(`SELECT conrelid::regclass::text AS table_name,
      conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE contype='f' AND confrelid='app_users'::regclass ORDER BY conrelid::regclass::text,conname`)).rows;
    const oldForeignKeys = await foreignKeys();
    const removedNames = new Set(HISTORY_COLUMNS.map(([table, column]) => {
      const key = oldForeignKeys.find(row => row.table_name === table
        && row.definition.startsWith(`FOREIGN KEY (${column})`));
      assert.ok(key, `${table}.${column} must have its original account foreign key`);
      return key.conname;
    }));

    app = createControlPlaneApp({ repository, storageRoot, logger: { info() {}, error() {} },
      analyzeCopy: async () => assert.fail('user deletion must never invoke a model'),
      analyzeVisual: async () => assert.fail('user deletion must never invoke a model'),
      onProgrammaticReady: async () => assert.fail('fixtures must never enqueue image generation') });
    server = await new Promise((resolve, reject) => {
      const value = app.listen(0, '127.0.0.1', () => resolve(value));
      value.once('error', reject);
    });
    const root = `http://127.0.0.1:${server.address().port}`;
    async function request(path, { actor = admin, method = 'GET', body } = {}) {
      const response = await fetch(`${root}${path}`, { method, headers: actorHeaders(actor),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const payload = await response.json();
      return { status: response.status, body: payload.data ?? payload };
    }
    const deleteUser = actor => request(`/v1/users/${actor.userId}`,
      { method: 'DELETE', body: { expectedVersion: 1 } });

    for (const victim of victims) {
      await t.test(`0098 reproduces the ${victim.table} foreign-key failure and rolls back`, async () => {
        const before = await snapshot();
        const response = await deleteUser(victim.actor);
        assert.equal(response.status, 500);
        assert.equal(response.body.error.code, 'INTERNAL_ERROR');
        const key = oldForeignKeys.find(row => row.table_name === victim.table
          && row.definition.startsWith(`FOREIGN KEY (${victim.column})`));
        await assert.rejects(repository.deleteUser(victim.actor.userId,
          { actorUsername: admin.username, expectedVersion: 1 }),
        error => {
          // PostgreSQL 18 reports RESTRICT violations as 23001; NO ACTION
          // relationships retain the ordinary foreign-key SQLSTATE 23503.
          assert.equal(error.code, key.definition.includes('ON DELETE RESTRICT') ? '23001' : '23503');
          if (error.constraint != null) assert.equal(error.constraint, key.conname);
          else assert.ok(error.message.includes(`"${key.conname}"`));
          return true;
        });
        assert.deepEqual(await snapshot(), before, 'failed deletes keep accounts, assignments and history intact');
      });
    }

    const beforeUpgrade = await snapshot();
    const upgraded = await migrate(pool, migrations);
    assert.ok(upgraded.some(id => id.startsWith('0099_')), 'the account-history repair must be applied');
    assert.deepEqual(await snapshot(), beforeUpgrade, 'upgrading must not rewrite historical identities or rows');
    assert.deepEqual(await migrate(pool, migrations), [], 'a repeated upgrade is a no-op');
    assert.deepEqual(await foreignKeys(), oldForeignKeys.filter(row => !removedNames.has(row.conname)),
      'live assignee, reviewer and owner relationships keep their existing foreign keys');
    for (const [table, column] of HISTORY_COLUMNS) {
      const shape = (await pool.query(`SELECT data_type,is_nullable FROM information_schema.columns
        WHERE table_schema='public' AND table_name=$1 AND column_name=$2`, [table, column])).rows[0];
      assert.deepEqual(shape, { data_type: 'bigint', is_nullable: 'NO' },
        `${table}.${column} remains a required immutable historical account ID`);
    }

    const historyTables = snapshotTables.filter(table => !['app_users', 'tasks', 'task_assignment_events',
      'query_packages', 'query_package_items'].includes(table));
    const historicalRows = await snapshot(historyTables);
    for (const victim of victims) {
      const response = await deleteUser(victim.actor);
      assert.equal(response.status, 200, `${victim.table} history must permit account deletion`);
      assert.equal(response.body.id, victim.actor.userId);
      assert.equal((await pool.query('SELECT id FROM app_users WHERE id=$1', [victim.actor.userId])).rowCount, 0);
      const task = (await pool.query(`SELECT assigned_to_user_id,assignment_source,assigned_at
        FROM tasks WHERE id=$1`, [victim.taskId])).rows[0];
      assert.deepEqual(task, { assigned_to_user_id: null, assignment_source: null, assigned_at: null });
      const event = (await pool.query(`SELECT actor_username,previous_assignee_user_id,assignee_user_id
        FROM task_assignment_events WHERE task_id=$1 ORDER BY id DESC LIMIT 1`, [victim.taskId])).rows[0];
      assert.deepEqual(event, { actor_username: admin.username,
        previous_assignee_user_id: victim.actor.username, assignee_user_id: null });
      assert.equal((await pool.query('SELECT assigned_to_account_id FROM query_packages WHERE id=$1',
        [victim.packageId])).rows[0].assigned_to_account_id, null);
      assert.equal((await pool.query(`SELECT screening_assigned_to_account_id FROM query_package_items
        WHERE query_package_id=$1`, [victim.packageId])).rows[0].screening_assigned_to_account_id, null);
    }
    assert.deepEqual(await snapshot(historyTables), historicalRows,
      'successful deletion preserves approvals, samples, planning results, uploads, edits, assets and remainders');

    const oldSubmitter = victims[0].actor;
    const lateFreeze = await freeze(oldSubmitter);
    await pool.query(`INSERT INTO image_sampling_remainders(production_batch_id,submitter_account_id,remainder_bps)
      VALUES($1,$2,7777) ON CONFLICT(production_batch_id,submitter_account_id)
      DO UPDATE SET remainder_bps=EXCLUDED.remainder_bps`, [batchId, oldSubmitter.userId]);
    assert.equal((await pool.query('SELECT submitter_account_id FROM image_sampling_freezes WHERE id=$1',
      [lateFreeze])).rows[0].submitter_account_id, String(oldSubmitter.userId));
    assert.equal((await pool.query(`SELECT remainder_bps FROM image_sampling_remainders
      WHERE production_batch_id=$1 AND submitter_account_id=$2`, [batchId, oldSubmitter.userId])).rows[0].remainder_bps, 7777,
    'late batch closure can retain and update the deleted submitter identity');

    const workspaceVictim = victims.find(({ table }) => table === 'standalone_image_workspaces');
    const replacementOwner = await createUser(workspaceVictim.actor.username);
    assert.notEqual(replacementOwner.userId, workspaceVictim.actor.userId);
    const listing = await request('/v1/image-editor/workspaces', { actor: replacementOwner });
    assert.equal(listing.status, 200);
    assert.deepEqual(listing.body, { total: 0, items: [] });
    const inaccessible = await request(`/v1/image-editor/workspaces/${workspaceVictim.taskId}`,
      { actor: replacementOwner });
    assert.equal(inaccessible.status, 403, 'a same-name account cannot open the deleted owner workspace');
    const removed = await request('/v1/image-editor/workspaces/delete', { actor: replacementOwner,
      method: 'POST', body: { workspaceIds: [Number(workspaceVictim.taskId)], requestId: randomUUID() } });
    assert.equal(removed.status, 403, 'a same-name account cannot mutate the deleted owner workspace');

    const planVictim = victims.find(({ table }) => table === 'copy_image_plan_regeneration_jobs');
    const replacementPlanner = await createUser(planVictim.actor.username);
    await pool.query(`UPDATE tasks SET state='COPY_REVIEW_PENDING',assigned_to_user_id=$2,
      assignment_source='MANUAL',assigned_at=now() WHERE id=$1`, [planVictim.taskId, replacementPlanner.username]);
    const replay = await request(`/v1/tasks/${planVictim.taskId}/regenerate-image-plan`,
      { actor: replacementPlanner, method: 'POST', body: { requestId: planVictim.requestId,
        copyRevisionId: Number(planVictim.revisionId), copy: content.copy } });
    assert.equal(replay.status, 409, JSON.stringify(replay.body));
    assert.equal(replay.body.error.code, 'IMAGE_PLAN_REGENERATION_REQUEST_CONFLICT');
    const job = (await pool.query(`SELECT requested_by_account_id,status FROM copy_image_plan_regeneration_jobs
      WHERE id=$1`, [planVictim.jobId])).rows[0];
    assert.deepEqual(job, { requested_by_account_id: String(planVictim.actor.userId), status: 'SUCCEEDED' },
      'the old request and completed result keep the deleted account identity');

    for (const state of ['COPY_QUEUED', 'COPY_REVIEW_PENDING', 'MANUAL_ARCHIVE', 'IMAGE_QC_PENDING']) {
      await t.test(`unfinished ordinary ${state} assignments still prevent deletion`, async () => {
        const actor = await createUser(`active-${state.toLowerCase()}`);
        await imageFixture(actor);
        await imageFixture(actor, { state });
        await queryAssignment(actor);
        const before = await snapshot();
        const response = await deleteUser(actor);
        assert.equal(response.status, 409);
        assert.equal(response.body.error.code, 'USER_HAS_ACTIVE_TASKS');
        assert.deepEqual(await snapshot(), before, 'active-task rejection rolls back every assignment and history change');
      });
    }
    for (const status of ['QUEUED', 'RUNNING']) {
      await t.test(`a ${status === 'RUNNING' ? 'unassigned ' : ''}standalone workspace with a ${status} edit still prevents deletion`, async () => {
        const actor = await createUser(`active-workspace-${status.toLowerCase()}`);
        const fixture = await imageFixture(actor, { state: 'MANUAL_ARCHIVE', standalone: true });
        await workspace(fixture, actor, status);
        if (status === 'RUNNING') {
          await pool.query(`UPDATE tasks SET assigned_to_user_id=NULL,assignment_source=NULL,assigned_at=NULL
            WHERE id=$1`, [fixture.taskId]);
        }
        await queryAssignment(actor);
        const before = await snapshot();
        const response = await deleteUser(actor);
        assert.equal(response.status, 409);
        assert.equal(response.body.error.code, 'USER_HAS_ACTIVE_TASKS');
        assert.deepEqual(await snapshot(), before, 'pending image generation keeps the account and workspace intact');
      });
    }
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await app?.context.disposeControlPlaneResources?.();
    await pool.end();
    await postgres.stop();
    const storagePath = resolve(storageRoot);
    assert.equal(dirname(storagePath), resolve(tmpdir()));
    assert.ok(basename(storagePath).startsWith('xhs-user-deletion-storage-'));
    await rm(storagePath, { recursive: true, force: true });
  }
});
