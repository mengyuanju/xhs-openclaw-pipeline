import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { planCopyQualityChunk, copyQualityImageGate } from '../src/copy-quality-flow.mjs';
import { startTemporaryPostgres18 } from './temporary-postgres18.mjs';

const RUN_POSTGRES_E2E = process.env.RUN_POSTGRES_E2E === '1';

test('sampling integer boundaries, full inspection, closing tails and per-account carry', () => {
  assert.deepEqual(planCopyQualityChunk({ count: 0, rateBps: 2000 }), { memberCount: 0, sampleCount: 0, remainder: 0 });
  assert.equal(planCopyQualityChunk({ count: 4, rateBps: 2000 }).memberCount, 0);
  assert.equal(planCopyQualityChunk({ count: 5, rateBps: 2000 }).sampleCount, 1);
  assert.equal(planCopyQualityChunk({ count: 1, rateBps: 10000 }).sampleCount, 1);
  assert.equal(planCopyQualityChunk({ count: 9, rateBps: 10000, close: true }).sampleCount, 9);
  assert.equal(planCopyQualityChunk({ count: 1, rateBps: 0 }).memberCount, 0);
  assert.equal(planCopyQualityChunk({ count: 1, rateBps: 0, close: true }).sampleCount, 1);
  const alice = planCopyQualityChunk({ count: 2, rateBps: 2000, close: true });
  assert.equal(alice.sampleCount, 1);
  assert.equal(alice.remainder, 4000);
  assert.equal(planCopyQualityChunk({ count: 3, rateBps: 2000, remainder: alice.remainder }).sampleCount, 1);
  assert.equal(planCopyQualityChunk({ count: 3, rateBps: 2000 }).memberCount, 0);
  assert.throws(() => planCopyQualityChunk({ count: -1, rateBps: 2000 }));
  assert.throws(() => copyQualityImageGate('untrusted'));
});

test('real PostgreSQL quality flow: isolation, concurrent freeze, batch return, recheck and final gate', {
  skip: !process.env.COPY_QUALITY_TEST_DATABASE_URL && !RUN_POSTGRES_E2E,
}, async t => {
  const { default: pg } = await import('pg');
  const { applyMigrations, loadMigrations } = await import('../src/database-migrations.mjs');
  const qa = await import('../src/copy-quality-control.mjs');
  const temporaryPostgres = process.env.COPY_QUALITY_TEST_DATABASE_URL
    ? null
    : await startTemporaryPostgres18('xhs-copy-quality-pg18-');
  const url = new URL(process.env.COPY_QUALITY_TEST_DATABASE_URL ?? temporaryPostgres.connectionString);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'test database must be local');
  const admin = new pg.Pool({ connectionString: url.href });
  const name = `qc_test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.href });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
    if (temporaryPostgres) await temporaryPostgres.stop();
  });
  // Exercise the merged production schema: 0053 reconciles the priority queue
  // assignments from 0050 with the account permissions introduced by 0051.
  const migrations = await loadMigrations();
  assert.ok(migrations.some(migration => migration.id === '0051_copy_quality_flow'));
  assert.ok(migrations.some(migration => migration.id === '0053_account_review_assignment'));
  const migrationClient = await pool.connect();
  try {
    for (let run = 0; run < 2; run++) {
      await migrationClient.query('BEGIN');
      const applied = await applyMigrations(migrationClient, migrations);
      if (run === 0) assert.ok(applied.includes('0051_copy_quality_flow'));
      else assert.deepEqual(applied, [], 'migration replay is a no-op');
      await migrationClient.query('COMMIT');
    }
  } catch (error) {
    await migrationClient.query('ROLLBACK');
    throw error;
  } finally {
    migrationClient.release();
  }
  await pool.query("INSERT INTO executor_nodes(id, name) VALUES ('qc-test', 'test')");
  const actors = [];
  for (const username of ['alice', 'bob', 'inspector']) {
    const u = (await pool.query(`INSERT INTO app_users(username, display_name, role, password_hash, copy_qc_enabled)
      VALUES ($1, $1, 'REVIEWER', 'not-a-credential', true) RETURNING *`, [username])).rows[0];
    actors.push({ userId: Number(u.id), username, role: u.role, credentialVersion: 1 });
  }
  const [alice, bob, inspector] = actors;
  await pool.query('UPDATE workflow_quality_settings SET copy_sampling_enabled = true, copy_sampling_rate_bps = 2000');
  const batch = (await pool.query(`INSERT INTO production_batches(
      public_id, client_batch_code, query_package_name,
      created_by_username, request_id, request_fingerprint
    ) VALUES ($1, '11111111111111111111111111111111', 'test', 'admin', $2, $3) RETURNING *`,
  [randomUUID(), randomUUID(), '0'.repeat(64)])).rows[0];
  const tasks = [];
  for (let n = 0; n < 12; n++) {
    const task = (await pool.query(`INSERT INTO tasks(query, created_by_node_id, copy_executor_node_id, state, production_batch_id, assigned_to_user_id, assignment_source, assigned_at)
      VALUES ($1, 'qc-test', 'qc-test', 'COPY_RUNNING', $2, $3, 'MANUAL', now()) RETURNING *`, [`test ${n}`, batch.id, n < 6 ? 'alice' : 'bob'])).rows[0];
    const revision = (await pool.query(`INSERT INTO copy_revisions(task_id, revision, content, approved_at) VALUES ($1, 1, $2, now()) RETURNING *`,
      [task.id, { copy: { title: `test ${n}`, body: 'body', tags: [] } }])).rows[0];
    await pool.query(`UPDATE tasks SET current_copy_revision_id = $2,
      state = 'COPY_REVIEW_PENDING', current_stage = 'COPY_REVIEW_PENDING' WHERE id = $1`, [task.id, revision.id]);
    await pool.query('INSERT INTO production_batch_items(production_batch_id, task_id, query_snapshot) VALUES ($1, $2, $3)', [batch.id, task.id, task.query]);
    task.current_copy_revision_id = revision.id;
    task.state = 'COPY_REVIEW_PENDING';
    tasks.push({ task, revision, actor: n < 6 ? alice : bob });
  }
  async function tx(action) {
    const c = await pool.connect();
    try { await c.query('BEGIN'); const r = await action(c); await c.query('COMMIT'); return r; }
    catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  async function approve(entry) {
    return tx(c => qa.routeManualCopyApproval(c, { ...entry, assessment: null, reviewSessionId: randomUUID(), aiDisclosureEnabled: false }));
  }
  for (const entry of tasks.slice(0, 5)) await approve(entry);
  let freezes = (await pool.query('SELECT * FROM copy_sampling_freezes ORDER BY id')).rows;
  assert.equal(freezes.length, 1);
  assert.equal(freezes[0].population_count, 5);
  assert.equal(freezes[0].sample_count, 1);
  assert.equal(Number(freezes[0].final_approver_account_id), alice.userId);
  const { selectStratifiedCopySample } = await import('../src/stratified-copy-sampling.mjs');
  const snapshot = (await pool.query('SELECT * FROM copy_sampling_items WHERE freeze_id = $1', [freezes[0].id])).rows;
  const replayedSample = selectStratifiedCopySample({ rateBps: freezes[0].rate_bps, seed: freezes[0].seed,
    sampleCount: freezes[0].sample_count, population: snapshot.map(row => ({ taskId: Number(row.task_id),
      copyRevisionId: Number(row.copy_revision_id), approvalEventId: Number(row.approval_event_id),
      finalApproverAccountId: Number(row.final_approver_account_id), contentSha256: row.content_sha256 })) });
  assert.equal(replayedSample.snapshotSha256, freezes[0].snapshot_sha256);
  for (const entry of tasks.slice(6, 11)) await approve(entry);
  freezes = (await pool.query('SELECT * FROM copy_sampling_freezes ORDER BY id')).rows;
  assert.equal(freezes.length, 2);
  assert.equal(Number(freezes[1].final_approver_account_id), bob.userId);
  await Promise.all([1, 2].map(() => tx(c => qa.attemptAutomaticCopySamplingFreeze(c, batch.id))));
  assert.equal(Number((await pool.query('SELECT count(*) FROM copy_sampling_freezes')).rows[0].count), 2);
  let item = (await pool.query('SELECT * FROM copy_sampling_items WHERE freeze_id = $1 AND selected', [freezes[0].id])).rows[0];
  const passInput = { requestId: randomUUID(), expectedCopyRevisionId: Number(item.copy_revision_id) };
  await assert.rejects(qa.passCopyQaItem(pool, item.public_id, passInput, alice), { code: 'FORBIDDEN' });
  await pool.query('UPDATE app_users SET copy_qc_enabled = false WHERE id = $1', [inspector.userId]);
  await assert.rejects(qa.passCopyQaItem(pool, item.public_id, passInput, inspector), { code: 'SESSION_STALE' });
  await pool.query('UPDATE app_users SET copy_qc_enabled = true WHERE id = $1', [inspector.userId]);
  const [result, concurrentReplay] = await Promise.all([1, 2].map(() => qa.passCopyQaItem(pool, item.public_id, passInput, inspector)));
  assert.deepEqual(concurrentReplay, result);
  assert.equal(result.releasedTaskIds.length, 5);
  assert.deepEqual(await qa.passCopyQaItem(pool, item.public_id, passInput, inspector), result);
  assert.equal(Number((await pool.query("SELECT count(*) FROM tasks WHERE state = 'IMAGE_QUEUED'")).rows[0].count), 5);
  // An admin image-only retry may create an approved PLAN_EDIT revision after
  // copy QA. Its explicit inheritance keeps the original verdict and image gate.
  const inheritedEntry = tasks.slice(0, 5)
    .find(entry => Number(entry.task.id) !== Number(item.task_id));
  const inheritedSource = (await pool.query(
    'SELECT * FROM copy_revisions WHERE id = $1',
    [inheritedEntry.revision.id],
  )).rows[0];
  const inheritedItemBefore = (await pool.query(
    'SELECT status FROM copy_sampling_items WHERE task_id = $1 AND copy_revision_id = $2',
    [inheritedEntry.task.id, inheritedSource.id],
  )).rows[0].status;
  await pool.query(`UPDATE tasks SET state = 'MANUAL_ARCHIVE', current_stage = 'MANUAL_ARCHIVE'
    WHERE id = $1`, [inheritedEntry.task.id]);
  const inheritedTarget = (await pool.query(`
    INSERT INTO copy_revisions(
      task_id, revision, parent_revision_id, content, approved_at,
      revision_origin, approval_mode
    ) VALUES ($1, 2, $2, $3, now(), 'PLAN_EDIT', 'MANUAL')
    RETURNING *
  `, [inheritedEntry.task.id, inheritedSource.id, {
    ...inheritedSource.content,
    imagePlan: [{ kind: 'hero', headline: '修正规划', subtitle: '', bullets: ['一', '二'], prompt: '修正图片规划' }],
    imageRevision: {
      version: 1,
      operation: 'REGENERATE',
      planEdited: true,
      baseRevisionId: Number(inheritedSource.id),
      baseImageRunId: randomUUID(),
      actorUsername: 'inspector',
      createdAt: new Date().toISOString(),
    },
  }])).rows[0];
  await pool.query(`
    INSERT INTO copy_qc_revision_inheritances(
      target_revision_id, task_id, source_revision_id,
      inherited_by_account_id, inherited_by_username, reason
    ) VALUES ($1, $2, $3, $4, $5, 'IMAGE_PLAN_RETRY')
  `, [inheritedTarget.id, inheritedEntry.task.id, inheritedSource.id,
    inspector.userId, inspector.username]);
  const inheritedTask = (await pool.query(`
    UPDATE tasks SET state = 'IMAGE_QUEUED', current_stage = 'IMAGE_QUEUED',
      current_copy_revision_id = $2, current_image_run_id = NULL
    WHERE id = $1 RETURNING *
  `, [inheritedEntry.task.id, inheritedTarget.id])).rows[0];
  assert.equal(inheritedTask.state, 'IMAGE_QUEUED');
  assert.equal(inheritedTask.mandatory_copy_qc, false);
  assert.equal(Number(inheritedTask.copy_qc_released_revision_id), Number(inheritedTarget.id));
  assert.equal((await pool.query(
    'SELECT status FROM copy_sampling_items WHERE task_id = $1 AND copy_revision_id = $2',
    [inheritedEntry.task.id, inheritedSource.id],
  )).rows[0].status, inheritedItemBefore);
  assert.equal((await pool.query(
    `SELECT ${copyQualityImageGate('task')} AS ok FROM tasks task WHERE id = $1`,
    [inheritedEntry.task.id],
  )).rows[0].ok, true);
  await pool.query(`UPDATE tasks SET state = 'MANUAL_ARCHIVE', current_stage = 'MANUAL_ARCHIVE'
    WHERE id = $1`, [inheritedEntry.task.id]);
  const untrustedContent = structuredClone(inheritedTarget.content);
  delete untrustedContent.imageRevision;
  untrustedContent.imagePlan = [
    { kind: 'hero', headline: '无来源规划', subtitle: '', bullets: ['一', '二'], prompt: '无来源图片规划' },
  ];
  const untrustedTarget = (await pool.query(`
    INSERT INTO copy_revisions(
      task_id, revision, parent_revision_id, content, approved_at,
      revision_origin, approval_mode
    ) VALUES ($1, 3, $2, $3, now(), 'PLAN_EDIT', 'MANUAL')
    RETURNING *
  `, [inheritedEntry.task.id, inheritedTarget.id, untrustedContent])).rows[0];
  await assert.rejects(pool.query(`
    INSERT INTO copy_qc_revision_inheritances(
      target_revision_id, task_id, source_revision_id,
      inherited_by_account_id, inherited_by_username, reason
    ) VALUES ($1, $2, $3, $4, $5, 'IMAGE_PLAN_RETRY')
  `, [untrustedTarget.id, inheritedEntry.task.id, inheritedTarget.id,
    inspector.userId, inspector.username]), { code: '23514' });
  const tamperedTarget = (await pool.query(`
    INSERT INTO copy_revisions(
      task_id, revision, parent_revision_id, content, approved_at,
      revision_origin, approval_mode
    ) VALUES ($1, 4, $2, $3, now(), 'PLAN_EDIT', 'MANUAL')
    RETURNING *
  `, [inheritedEntry.task.id, inheritedTarget.id, {
    ...inheritedTarget.content,
    copy: { ...inheritedTarget.content.copy, title: '借图片返修偷改文案' },
    imageRevision: {
      ...inheritedTarget.content.imageRevision,
      baseRevisionId: Number(inheritedTarget.id),
      createdAt: new Date().toISOString(),
    },
  }])).rows[0];
  await assert.rejects(pool.query(`
    INSERT INTO copy_qc_revision_inheritances(
      target_revision_id, task_id, source_revision_id,
      inherited_by_account_id, inherited_by_username, reason
    ) VALUES ($1, $2, $3, $4, $5, 'IMAGE_PLAN_RETRY')
  `, [tamperedTarget.id, inheritedEntry.task.id, inheritedTarget.id,
    inspector.userId, inspector.username]), { code: '23514' });
  await pool.query(`UPDATE tasks SET state = 'IMAGE_QUEUED', current_stage = 'IMAGE_QUEUED'
    WHERE id = $1`, [inheritedEntry.task.id]);
  // A returned batch affects Bob only and retains the original reviewer.
  const preview = await qa.getCopyQaBatchReturnPreview(pool, freezes[1].public_id, inspector);
  const input = { requestId: randomUUID(), freezePublicId: freezes[1].public_id,
    triggerSamplingItemId: preview.triggerCandidates[0], itemIds: preview.items.map(i => i.id), confirmedCount: 5, note: 'incorrect copy' };
  await qa.batchReturnCopyQa(pool, input, inspector);
  await qa.batchReturnCopyQa(pool, input, inspector);
  const returned = (await pool.query('SELECT * FROM tasks WHERE mandatory_copy_qc ORDER BY id')).rows;
  assert.equal(returned.length, 5);
  assert.deepEqual([...new Set(returned.map(row => row.state))], ['COPY_REVIEW_PENDING']);
  assert.deepEqual([...new Set(returned.map(row => row.assigned_to_user_id))], ['bob']);
  assert.deepEqual([...new Set(returned.map(row => row.rework_count))], [1]);
  for (const row of returned) {
    const revision = (await pool.query('SELECT * FROM copy_revisions WHERE id = $1', [row.current_copy_revision_id])).rows[0];
    // The review API normally appends this edited revision; exercise the route with it.
    const edited = (await pool.query(`INSERT INTO copy_revisions(task_id, revision, parent_revision_id, content, approved_at)
      VALUES ($1, $2, $3, $4, now()) RETURNING *`, [row.id, Number(revision.revision) + 1, revision.id, { copy: { title: 'repaired', body: 'corrected' } }])).rows[0];
    await tx(c => qa.routeManualCopyApproval(c, { task: row, revision: edited, actor: bob, aiDisclosureEnabled: false }));
  }
  const rechecks = (await pool.query("SELECT * FROM copy_sampling_items WHERE sample_kind = 'MANDATORY_RECHECK' ORDER BY id")).rows;
  assert.equal(rechecks.length, 5);
  for (let i = 0; i < rechecks.length; i++) {
    const recheck = rechecks[i];
    await qa.passCopyQaItem(pool, recheck.public_id, { requestId: randomUUID(), expectedCopyRevisionId: Number(recheck.copy_revision_id) }, inspector);
    if (i < 4) assert.equal(Number((await pool.query("SELECT count(*) FROM tasks WHERE assigned_to_user_id = 'bob' AND state = 'IMAGE_QUEUED'")).rows[0].count), 0);
  }
  assert.equal(Number((await pool.query("SELECT count(*) FROM tasks WHERE state = 'IMAGE_QUEUED'")).rows[0].count), 10);
  const eligible = await pool.query(`SELECT count(*) FROM tasks task WHERE ${copyQualityImageGate('task')}`);
  assert.equal(Number(eligible.rows[0].count), 10);
  // A stale approval, mandatory flag or new version independently closes the DB gate.
  const changed = tasks.find(entry => Number(entry.task.id) === Number(item.task_id)).task;
  await pool.query('UPDATE tasks SET mandatory_copy_qc = true WHERE id = $1', [changed.id]);
  assert.equal((await pool.query(`SELECT ${copyQualityImageGate('task')} AS ok FROM tasks task WHERE id = $1`, [changed.id])).rows[0].ok, false);
  const changedSource = (await pool.query(
    'SELECT * FROM copy_revisions WHERE id = $1',
    [changed.current_copy_revision_id],
  )).rows[0];
  const newer = (await pool.query(`INSERT INTO copy_revisions(
      task_id, revision, parent_revision_id, content, approved_at, revision_origin, approval_mode
    ) VALUES ($1, 2, $2, $3, now(), 'PLAN_EDIT', 'MANUAL') RETURNING id`,
  [changed.id, changedSource.id, {
    ...changedSource.content,
    imagePlan: [{ kind: 'hero', headline: '未授权继承', subtitle: '', bullets: ['一', '二'], prompt: '修改图片规划' }],
    imageRevision: {
      version: 1,
      operation: 'REGENERATE',
      planEdited: true,
      baseRevisionId: Number(changedSource.id),
      baseImageRunId: randomUUID(),
      actorUsername: 'inspector',
      createdAt: new Date().toISOString(),
    },
  }])).rows[0];
  const blockedPlanEdit = (await pool.query(`UPDATE tasks SET current_copy_revision_id = $2,
    state = 'IMAGE_QUEUED', current_stage = 'IMAGE_QUEUED', mandatory_copy_qc = false
    WHERE id = $1 RETURNING *`, [changed.id, newer.id])).rows[0];
  assert.equal(blockedPlanEdit.state, 'COPY_REVIEW_PENDING');
  assert.equal(blockedPlanEdit.mandatory_copy_qc, true);
  assert.equal((await pool.query('SELECT status FROM copy_sampling_items WHERE id = $1', [item.id])).rows[0].status, 'SUPERSEDED');
  assert.notEqual((await pool.query(`SELECT ${copyQualityImageGate('task')} AS ok FROM tasks task WHERE id = $1`, [changed.id])).rows[0].ok, true);
  // Manual closure freezes an incomplete person's nonempty tail, never zero samples.
  await approve(tasks[5]);
  const tailCountBefore = Number((await pool.query('SELECT count(*) FROM copy_sampling_freezes')).rows[0].count);
  await Promise.all([1, 2].map(() => tx(c => qa.attemptAutomaticCopySamplingFreeze(c, batch.id, null, { close: true }))));
  assert.equal(Number((await pool.query('SELECT count(*) FROM copy_sampling_freezes')).rows[0].count), tailCountBefore + 1);
  const tail = (await pool.query('SELECT * FROM copy_sampling_freezes ORDER BY id DESC LIMIT 1')).rows[0];
  assert.equal(tail.population_count, 1);
  assert.equal(tail.sample_count, 1);
  assert.equal(tail.remainder_after, 2000);

  // A pending, unapproved sibling must not keep an aged tail open forever.
  const blocker = (await pool.query(`INSERT INTO tasks(query, created_by_node_id, copy_executor_node_id, production_batch_id)
    VALUES ('blocker', 'qc-test', 'qc-test', $1) RETURNING id`, [batch.id])).rows[0];
  await pool.query("INSERT INTO production_batch_items(production_batch_id, task_id, query_snapshot) VALUES ($1, $2, 'blocker')", [batch.id, blocker.id]);
  await approve(tasks[11]);
  await pool.query("UPDATE copy_approval_events SET approved_at = now() - interval '31 minutes' WHERE task_id = $1", [tasks[11].task.id]);
  await qa.flushExpiredCopyQualityBatches(pool);
  const expired = (await pool.query('SELECT * FROM copy_sampling_freezes ORDER BY id DESC LIMIT 1')).rows[0];
  assert.equal(expired.close_reason, 'TIMEOUT');
  assert.equal(expired.sample_count, 1);
  assert.equal(expired.population_count, 1);

  // Single return uses the same mandatory chain and cannot be passed using its old token.
  const single = (await pool.query('SELECT * FROM copy_sampling_items WHERE freeze_id = $1', [tail.id])).rows[0];
  const returnedInput = { requestId: randomUUID(), expectedCopyRevisionId: Number(single.copy_revision_id), note: 'single correction' };
  await qa.returnCopyQaItem(pool, single.public_id, returnedInput, inspector);
  await qa.returnCopyQaItem(pool, single.public_id, returnedInput, inspector);
  await assert.rejects(qa.passCopyQaItem(pool, single.public_id, { ...returnedInput, requestId: randomUUID() }, inspector), { code: 'STALE_QA_ITEM' });
  const singleTask = (await pool.query('SELECT * FROM tasks WHERE id = $1', [single.task_id])).rows[0];
  assert.equal(singleTask.rework_count, 1);
  assert.equal(singleTask.mandatory_copy_qc, true);

  // Final-image copy return has no sampling parent and still requires a new 100% QA round.
  const finalTask = (await pool.query('SELECT * FROM tasks WHERE id = $1', [returned[0].id])).rows[0];
  await pool.query("UPDATE tasks SET state = 'COPY_REVIEW_PENDING', mandatory_copy_qc = true, mandatory_copy_qc_origin = 'FINAL_REWORK' WHERE id = $1", [finalTask.id]);
  Object.assign(finalTask, { state: 'COPY_REVIEW_PENDING', mandatory_copy_qc: true, mandatory_copy_qc_origin: 'FINAL_REWORK' });
  const finalRevision = (await pool.query(`INSERT INTO copy_revisions(task_id, revision, content, parent_revision_id, approved_at)
    SELECT $1, max(revision) + 1, $2, $3, now() FROM copy_revisions WHERE task_id = $1 RETURNING *`,
  [finalTask.id, { copy: { title: 'final repair', body: 'corrected' } }, finalTask.current_copy_revision_id])).rows[0];
  const finalRoute = await tx(c => qa.routeManualCopyApproval(c, { task: finalTask, revision: finalRevision, actor: bob, aiDisclosureEnabled: false }));
  assert.equal(finalRoute.samplingItem.sample_kind, 'MANDATORY_RECHECK');
  assert.equal(finalRoute.task.state, 'COPY_QC_PENDING');
  await qa.passCopyQaItem(pool, finalRoute.samplingItem.public_id, { requestId: randomUUID(), expectedCopyRevisionId: Number(finalRevision.id) }, inspector);
  assert.equal((await pool.query(`SELECT ${copyQualityImageGate('task')} AS ok FROM tasks task WHERE id = $1`, [finalTask.id])).rows[0].ok, true);
  await assert.rejects(pool.query('UPDATE copy_revisions SET content = $2 WHERE id = $1', [finalRevision.id, { copy: {} }]), { code: '23514' });

  const { PostgresControlPlaneRepository } = await import('../src/postgres-repository.mjs');
  const repository = new PostgresControlPlaneRepository({ pool });
  await repository.updateUser(alice.userId, { displayName: 'alice', role: 'REVIEWER', status: 'ACTIVE', expectedVersion: 1,
    copyReviewEnabled: false, copyQcEnabled: true, actorUsername: 'admin' });
  assert.equal((await pool.query('SELECT assigned_to_user_id FROM tasks WHERE id = $1', [single.task_id])).rows[0].assigned_to_user_id, null);
  assert.equal(Number((await pool.query('SELECT count(*) FROM copy_quality_permission_events WHERE account_id = $1', [alice.userId])).rows[0].count), 1);
  await assert.rejects(pool.query("UPDATE tasks SET assigned_to_user_id = 'alice', assignment_source = 'MANUAL', assigned_at = now() WHERE id = $1", [blocker.id]), { code: '23514' });
});
