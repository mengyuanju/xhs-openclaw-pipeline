import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { startTemporaryPostgres18 } from './temporary-postgres18.mjs';
import { applyMigrations, loadMigrations } from '../src/database-migrations.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { createControlPlaneApp } from '../src/http-server.mjs';
import * as qa from '../src/copy-quality-control.mjs';

test('account sampling PostgreSQL and HTTP: inheritance, audit, freeze isolation, rechecks and permissions', {
  skip: process.env.RUN_POSTGRES_E2E !== '1', timeout: 120000,
}, async (t) => {
  const temporary = await startTemporaryPostgres18('xhs-account-copy-sampling-pg18-');
  const pool = new pg.Pool({ connectionString: temporary.connectionString });
  let server;
  t.after(async () => {
    try {
      if (server) await new Promise(resolve => server.close(resolve));
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
  const app = createControlPlaneApp({ repository, storageRoot: 'test-storage' });
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
  const freezes = async batchId => (await pool.query('SELECT * FROM copy_sampling_freezes WHERE production_batch_id = $1 ORDER BY id', [batchId])).rows;
  const close = batchId => tx(client => qa.attemptAutomaticCopySamplingFreeze(client, batchId, admin, { close: true }));

  const sharedBatch = await batch();
  let original;
  await t.test('one batch uses account 50% and default 20%, recording immutable policy provenance', async () => {
    for (let i = 0; i < 2; i++) await approve(sharedBatch, alice);
    for (let i = 0; i < 5; i++) await approve(sharedBatch, bob);
    original = await freezes(sharedBatch.id);
    assert.deepEqual(original.map(row => [Number(row.final_approver_account_id), row.rate_bps, row.rate_source, row.population_count, row.sample_count]),
      [[alice.id, 5000, 'ACCOUNT_OVERRIDE', 2, 1], [bob.id, 2000, 'GLOBAL_DEFAULT', 5, 1]]);
    assert.equal(Number(original[0].account_policy_version), alice.version);
    const details = (await pool.query("SELECT details FROM copy_sampling_events WHERE freeze_id = $1 AND action = 'FREEZE'", [original[0].id])).rows[0].details;
    assert.equal(details.effectiveRateBps, 5000);
    assert.equal(details.rateSource, 'ACCOUNT_OVERRIDE');
    const sample = (await pool.query('SELECT * FROM copy_sampling_items WHERE freeze_id = $1 AND selected', [original[0].id])).rows[0];
    const full = await qa.getCopyQaItem(pool, sample.public_id, admin);
    assert.equal(full.samplingPolicy.rateBps, 5000);
    assert.equal(full.samplingPolicy.accountPolicyVersion, alice.version);
    const blind = await qa.getCopyQaItem(pool, sample.public_id, actorOf(inspector));
    assert.equal(blind.blindReview, true);
    assert.equal(Object.hasOwn(blind, 'samplingPolicy'), false);
  });

  await t.test('a new rate applies to unfrozen approvals only and carries fractional quota', async () => {
    await approve(sharedBatch, alice); // 1 of 2: waiting for a complete chunk.
    Object.assign(alice, await update(alice, { copySamplingRateBpsOverride: 10000 }));
    await tx(client => qa.attemptAutomaticCopySamplingFreeze(client, sharedBatch.id));
    assert.deepEqual((await freezes(sharedBatch.id)).slice(0, 2), original);
    assert.equal((await freezes(sharedBatch.id)).at(-1).rate_bps, 10000);
    Object.assign(alice, await update(alice, { copySamplingRateBpsOverride: 2500 }));
    await approve(sharedBatch, alice);
    await close(sharedBatch.id);
    assert.equal((await freezes(sharedBatch.id)).at(-1).remainder_after, 2500);
    Object.assign(alice, await update(alice, { copySamplingRateBpsOverride: 7500 }));
    await approve(sharedBatch, alice);
    const latest = (await freezes(sharedBatch.id)).at(-1);
    assert.equal(latest.remainder_before, 2500);
    assert.equal(latest.remainder_after, 0);
    assert.equal(latest.sample_count, 1);
  });

  await t.test('explicit zero retains manual/timeout safety samples; deleted accounts inherit the global rate', async () => {
    const zeroUser = await create('zero.user', 0);
    const zeroBatch = await batch();
    await approve(zeroBatch, zeroUser);
    assert.equal((await freezes(zeroBatch.id)).length, 0);
    await close(zeroBatch.id);
    assert.equal((await freezes(zeroBatch.id))[0].rate_bps, 0);
    assert.equal((await freezes(zeroBatch.id))[0].sample_count, 1);
    const tail = await approve(zeroBatch, zeroUser);
    await pool.query("UPDATE copy_approval_events SET approved_at = now() - interval '31 minutes' WHERE task_id = $1", [tail.task.id]);
    await qa.flushExpiredCopyQualityBatches(pool);
    assert.equal((await freezes(zeroBatch.id)).at(-1).close_reason, 'TIMEOUT');
    assert.equal((await freezes(zeroBatch.id)).at(-1).sample_count, 1);
    const gone = await create('deleted.user', 1);
    const goneBatch = await batch();
    await approve(goneBatch, gone);
    await pool.query('DELETE FROM app_users WHERE id = $1', [gone.id]);
    await close(goneBatch.id);
    const fallback = (await freezes(goneBatch.id))[0];
    assert.equal(fallback.rate_bps, 2000);
    assert.equal(fallback.rate_source, 'GLOBAL_DEFAULT');
    assert.equal(fallback.account_policy_version, null);
    assert.equal((await pool.query('SELECT * FROM account_copy_sampling_policy_events WHERE account_id = $1', [gone.id])).rows.length, 1);
  });

  await t.test('global stop bypasses normal sampling but rework still creates a 100% mandatory round', async () => {
    await pool.query('UPDATE workflow_quality_settings SET copy_sampling_enabled = false');
    const disabledBatch = await batch();
    const entry = await approve(disabledBatch, alice);
    assert.equal((await pool.query('SELECT state FROM tasks WHERE id = $1', [entry.task.id])).rows[0].state, 'IMAGE_QUEUED');
    assert.equal((await freezes(disabledBatch.id)).length, 0);
    const task = (await pool.query(`UPDATE tasks SET state = 'COPY_REVIEW_PENDING', mandatory_copy_qc = true,
      mandatory_copy_qc_origin = 'FINAL_REWORK' WHERE id = $1 RETURNING *`, [entry.task.id])).rows[0];
    const revision = (await pool.query(`INSERT INTO copy_revisions(task_id, revision, content, approved_at)
      VALUES ($1, 2, $2, now()) RETURNING *`, [task.id, { copy: { title: 'repaired', body: 'new content' } }])).rows[0];
    const routed = await tx(client => qa.routeManualCopyApproval(client, { task, revision, actor: actorOf(alice), aiDisclosureEnabled: false }));
    const mandatory = (await pool.query('SELECT * FROM copy_sampling_freezes WHERE id = $1', [routed.samplingItem.freeze_id])).rows[0];
    assert.equal(mandatory.rate_bps, 10000);
    assert.equal(mandatory.rate_source, 'MANDATORY_RECHECK');
    assert.equal(mandatory.sample_count, 1);
    assert.equal(routed.task.state, 'COPY_QC_PENDING');
  });
});
