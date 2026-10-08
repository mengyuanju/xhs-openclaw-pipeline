import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { startTemporaryPostgres18 } from './temporary-postgres18.mjs';
import { applyMigrations, loadMigrations } from '../src/database-migrations.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { createControlPlaneApp } from '../src/http-server.mjs';
import * as qa from '../src/copy-quality-control.mjs';
import { listCopyQaBatchItemsV2 } from '../src/copy-qa-v2.mjs';

test('account sampling PostgreSQL and HTTP: inheritance, audit, freeze isolation, rechecks and permissions', {
  skip: process.env.RUN_POSTGRES_E2E !== '1', timeout: 120000,
}, async (t) => {
  const temporary = await startTemporaryPostgres18('xhs-account-copy-sampling-pg18-');
  const pool = new pg.Pool({ connectionString: temporary.connectionString });
  let server, app;
  t.after(async () => {
    try {
      if (server) await new Promise(resolve => server.close(resolve));
      // Route maintenance can still be using the pool after HTTP connections
      // close. Drain it before ending the temporary PostgreSQL connection pool.
      await app?.context.disposeControlPlaneResources?.();
      await pool.end();
    } finally { await temporary.stop(); }
  });
  async function tx(action) {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const result = await action(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  const migrations = await loadMigrations();
  await tx(client => applyMigrations(client, migrations.filter(m => m.id !== '0084_account_copy_sampling_rate')));
  await tx(async client => {
    assert.deepEqual(await applyMigrations(client, migrations), ['0084_account_copy_sampling_rate']);
    assert.deepEqual(await applyMigrations(client, migrations), []);
  });
  assert.ok((await pool.query('SELECT copy_sampling_rate_bps_override FROM app_users')).rows.every(row => row.copy_sampling_rate_bps_override === null));
  await pool.query("UPDATE app_users SET must_change_password = false WHERE username = 'admin'");
  await pool.query("INSERT INTO executor_nodes(id, name) VALUES ('sampling-test', 'test')");
  await pool.query('UPDATE workflow_quality_settings SET copy_sampling_enabled = true, copy_sampling_rate_bps = 2000, blind_review_enabled = true');
  const repository = new PostgresControlPlaneRepository({ pool });
  const admin = { userId: 1, username: 'admin', role: 'ADMIN', credentialVersion: 1 };
  app = createControlPlaneApp({ repository, storageRoot: 'test-storage' });
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  async function request(path, method = 'GET', body, actor = admin) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: { 'content-type': 'application/json',
        'X-Actor-User-Id': String(actor.userId), 'X-Actor-Username': actor.username,
        'X-Actor-Role': actor.role, 'X-Actor-Credential-Version': String(actor.credentialVersion) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, ...await response.json() };
  }
  async function create(username, override, role = 'USER') {
    const response = await request('/v1/users', 'POST', { username, displayName: username, role,
      copyQcEnabled: role === 'REVIEWER', ...(override === undefined ? {} : { copySamplingRateBpsOverride: override }),
      actorAccountId: 9999, actorUsername: 'forged' });
    assert.equal(response.status, 201, JSON.stringify(response));
    await pool.query('UPDATE app_users SET must_change_password = false WHERE id = $1', [response.data.id]);
    return response.data;
  }
  const alice = await create('alice', 5000);
  const bob = await create('bobby');
  const inspector = await create('inspector', undefined, 'REVIEWER');
  const actorOf = user => ({ userId: user.id, username: user.username, role: user.role, credentialVersion: user.credentialVersion });
  async function update(user, patch) {
    const response = await request(`/v1/users/${user.id}`, 'PATCH', { displayName: user.displayName, role: user.role,
      status: user.status, expectedVersion: user.version, ...patch });
    assert.equal(response.status, 200, JSON.stringify(response));
    return response.data;
  }
  await t.test('HTTP changes validate, preserve omitted values, audit actual changes and retain sessions', async () => {
    assert.equal(bob.copySamplingRateBpsOverride, null);
    const auditBefore = (await pool.query('SELECT * FROM account_copy_sampling_policy_events')).rows;
    assert.equal(auditBefore.length, 1);
    assert.equal(Number(auditBefore[0].actor_account_id), admin.userId);
    assert.equal(auditBefore[0].actor_username, 'admin');
    let user = await update(alice, { displayName: 'Alice renamed' });
    assert.equal(user.copySamplingRateBpsOverride, 5000, 'old clients omit the new field');
    user = await update(user, { copySamplingRateBpsOverride: 5000 });
    assert.equal((await pool.query('SELECT * FROM account_copy_sampling_policy_events')).rows.length, 1);
    for (const invalid of [-1, 10001, 12.5, '5000', false]) {
      assert.equal((await request(`/v1/users/${user.id}`, 'PATCH', { ...user, expectedVersion: user.version, copySamplingRateBpsOverride: invalid })).status, 400);
    }
    user = await update(user, { copySamplingRateBpsOverride: 0 });
    assert.equal(user.copySamplingRateBpsOverride, 0);
    assert.equal(user.credentialVersion, alice.credentialVersion);
    const profile = await request('/v1/profile', 'GET', undefined, actorOf(user));
    assert.equal(profile.status, 200);
    assert.equal(Object.hasOwn(profile.data, 'copySamplingRateBpsOverride'), false, 'policy is only exposed through admin DTOs');
    const stale = await request(`/v1/users/${user.id}`, 'PATCH', { ...user, expectedVersion: alice.version, copySamplingRateBpsOverride: 3000 });
    assert.equal(stale.error.code, 'VERSION_CONFLICT');
    user = await update(user, { copySamplingRateBpsOverride: null });
    assert.equal(user.copySamplingRateBpsOverride, null);
    user = await update(user, { copySamplingRateBpsOverride: 5000 });
    Object.assign(alice, user);
    for (const actor of [actorOf(bob), actorOf(inspector)]) {
      assert.equal((await request('/v1/users', 'GET', undefined, actor)).status, 403);
      assert.equal((await request('/v1/users', 'POST', { username: 'forbidden' }, actor)).status, 403);
      assert.equal((await request(`/v1/users/${alice.id}`, 'PATCH', { ...alice, expectedVersion: alice.version, copySamplingRateBpsOverride: 0 }, actor)).status, 403);
    }
    assert.equal((await request('/health')).data.capabilities.copySamplingVersion, 2);
    const list = await request('/v1/users');
    assert.equal(list.data.find(user => user.id === alice.id).copySamplingRateBpsOverride, 5000);
    const audit = (await pool.query('SELECT * FROM account_copy_sampling_policy_events ORDER BY id')).rows;
    assert.deepEqual(audit.map(row => [row.previous_rate_bps_override, row.rate_bps_override]), [[null, 5000], [5000, 0], [0, null], [null, 5000]]);
  });

  async function batch() {
    const row = (await pool.query(`INSERT INTO production_batches(public_id, client_batch_code, query_package_name,
      created_by_username, request_id, request_fingerprint) VALUES ($1, $2, 'sampling test', 'admin', $3, $4) RETURNING *`,
    [randomUUID(), randomUUID().replaceAll('-', ''), randomUUID(), '0'.repeat(64)])).rows[0];
    const blocker = (await pool.query("INSERT INTO tasks(query, created_by_node_id, copy_executor_node_id, production_batch_id) VALUES ('unapproved sibling', 'sampling-test', 'sampling-test', $1) RETURNING id", [row.id])).rows[0];
    await pool.query("INSERT INTO production_batch_items(production_batch_id, task_id, query_snapshot) VALUES ($1, $2, 'unapproved sibling')", [row.id, blocker.id]);
    return row;
  }
  async function approve(batchRow, user) {
    const task = (await pool.query(`INSERT INTO tasks(query, created_by_node_id, copy_executor_node_id, state, production_batch_id)
      VALUES ('sampling copy', 'sampling-test', 'sampling-test', 'COPY_RUNNING', $1) RETURNING *`, [batchRow.id])).rows[0];
    const revision = (await pool.query(`INSERT INTO copy_revisions(task_id, revision, content, approved_at)
      VALUES ($1, 1, $2, now()) RETURNING *`, [task.id, { copy: { title: 'sample title', body: 'sample content', tags: [] } }])).rows[0];
    await pool.query("UPDATE tasks SET state = 'COPY_REVIEW_PENDING', current_stage = 'COPY_REVIEW_PENDING', current_copy_revision_id = $2 WHERE id = $1", [task.id, revision.id]);
    await pool.query("INSERT INTO production_batch_items(production_batch_id, task_id, query_snapshot) VALUES ($1, $2, 'sampling copy')", [batchRow.id, task.id]);
    Object.assign(task, { state: 'COPY_REVIEW_PENDING', current_copy_revision_id: revision.id });
    await tx(client => qa.routeManualCopyApproval(client, { task, revision, actor: actorOf(user), reviewSessionId: randomUUID(), aiDisclosureEnabled: false }));
    return { task, revision };
  }
  // V2 freezes policy in personal QA batches, rather than production-batch
  // legacy freezes or fractional carry. Test the current account batch sizes.
  Object.assign(alice, await update(alice, { autoCopyBatchSize: 2 }));
  Object.assign(bob, await update(bob, { autoCopyBatchSize: 5 }));
  const batches = async () => (await pool.query('SELECT * FROM copy_qa_batches_v2 ORDER BY id')).rows;

  const sharedBatch = await batch();
  let original;
  await t.test('personal V2 batches use account 50% and default 20% with immutable policy snapshots', async () => {
    for (let i = 0; i < 2; i++) await approve(sharedBatch, alice);
    for (let i = 0; i < 5; i++) await approve(sharedBatch, bob);
    original = await batches();
    assert.deepEqual(original.map(row => [Number(row.account_id),row.sampling_rate_bps,row.member_count,row.sample_count]),
      [[alice.id,5000,2,1],[bob.id,2000,5,1]]);
    const full = await listCopyQaBatchItemsV2(pool,original[0].public_id,admin);
    assert.equal(full.items.length,1);
    assert.equal(full.items[0].approverUsername,alice.username);
    assert.ok(Number.isSafeInteger(full.items[0].taskId));
    const blind = await listCopyQaBatchItemsV2(pool,original[0].public_id,actorOf(inspector));
    assert.equal(blind.items[0].taskId,null);
    assert.equal(blind.items[0].query,null);
    assert.equal(blind.items[0].approverUsername,null);
    assert.equal(Number((await pool.query('SELECT count(*) FROM copy_sampling_freezes')).rows[0].count),0);
  });

  await t.test('a changed account rate affects future V2 batches while existing snapshots stay unchanged', async () => {
    await approve(sharedBatch, alice);
    Object.assign(alice, await update(alice, { copySamplingRateBpsOverride: 10000 }));
    await approve(sharedBatch, alice);
    assert.deepEqual((await batches()).slice(0,2),original);
    assert.equal((await batches()).at(-1).sampling_rate_bps,10000);
    assert.equal((await batches()).at(-1).sample_count,2);
    Object.assign(alice, await update(alice, { copySamplingRateBpsOverride: 2500 }));
    await approve(sharedBatch, alice);
    await approve(sharedBatch, alice);
    assert.equal((await batches()).at(-1).sampling_rate_bps,2500);
    assert.equal((await batches()).at(-1).sample_count,1);
    Object.assign(alice, await update(alice, { copySamplingRateBpsOverride: 7500 }));
    await approve(sharedBatch, alice);
    await approve(sharedBatch, alice);
    const latest = (await batches()).at(-1);
    assert.equal(latest.sampling_rate_bps,7500);
    assert.equal(latest.sample_count,2);
  });

  await t.test('explicit zero V2 sampling releases a completed batch and deleted-account audit survives', async () => {
    const zeroUser = await create('zero.user', 0);
    const zeroBatch = await batch();
    Object.assign(zeroUser,await update(zeroUser,{autoCopyBatchSize:1}));
    const zeroEntry = await approve(zeroBatch,zeroUser);
    const zero = (await batches()).at(-1);
    assert.equal(zero.sampling_rate_bps,0);
    assert.equal(zero.sample_count,0);
    assert.equal(zero.status,'COMPLETED');
    assert.equal((await pool.query('SELECT state FROM tasks WHERE id=$1',[zeroEntry.task.id])).rows[0].state,'IMAGE_QUEUED');
    const gone = await create('deleted.user', 1);
    const goneBatch = await batch();
    await approve(goneBatch, gone);
    await pool.query('DELETE FROM app_users WHERE id = $1', [gone.id]);
    assert.equal((await pool.query('SELECT * FROM account_copy_sampling_policy_events WHERE account_id = $1', [gone.id])).rows.length, 1);
    assert.equal((await request('/v1/profile','GET',undefined,actorOf(gone))).status,401);
  });

  await t.test('global stop bypasses normal sampling but rework still creates a 100% mandatory round', async () => {
    await pool.query('UPDATE workflow_quality_settings SET copy_sampling_enabled = false');
    const disabledBatch = await batch();
    const entry = await approve(disabledBatch, alice);
    assert.equal((await pool.query('SELECT state FROM tasks WHERE id = $1', [entry.task.id])).rows[0].state, 'IMAGE_QUEUED');
    assert.equal((await pool.query('SELECT count(*) FROM copy_qa_batch_members_v2 WHERE task_id=$1',[entry.task.id])).rows[0].count,'0');
    const task = (await pool.query(`UPDATE tasks SET state = 'COPY_REVIEW_PENDING', mandatory_copy_qc = true,
      mandatory_copy_qc_origin = 'FINAL_REWORK' WHERE id = $1 RETURNING *`, [entry.task.id])).rows[0];
    const revision = (await pool.query(`INSERT INTO copy_revisions(task_id, revision, content, approved_at)
      VALUES ($1, 2, $2, now()) RETURNING *`, [task.id, { copy: { title: 'repaired', body: 'new content' } }])).rows[0];
    const routed = await tx(client => qa.routeManualCopyApproval(client, { task, revision, actor: actorOf(alice), aiDisclosureEnabled: false }));
    const mandatory = (await pool.query(`SELECT batch.* FROM copy_qa_batches_v2 batch
      JOIN copy_qa_batch_members_v2 member ON member.batch_id=batch.id WHERE member.task_id=$1
      ORDER BY batch.id DESC LIMIT 1`,[task.id])).rows[0];
    assert.equal(mandatory.sampling_rate_bps, 10000);
    assert.equal(mandatory.full_inspection,true);
    assert.equal(mandatory.sample_count, 1);
    assert.equal(routed.task.state, 'COPY_QC_PENDING');
  });
});
