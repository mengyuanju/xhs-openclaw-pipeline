import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { applyMigrations, loadMigrations } from '../src/database-migrations.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { startTemporaryPostgres18 } from './helpers/personal-postgres.mjs';

test('same-run image submissions keep one approval per quality fact and preserve captured history', {
  skip: process.env.RUN_OPERATOR_PERFORMANCE_POSTGRES !== '1',
  timeout: 180_000,
}, async () => {
  const database = await startTemporaryPostgres18();
  const repository = new PostgresControlPlaneRepository({ connectionString: database.connectionString });
  const db = repository.pool;
  try {
    const migrations = await loadMigrations();
    async function migrate(selected) {
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await applyMigrations(client, selected);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
    await migrate(migrations.filter(({ id }) => id < '0098_image_rework_quality_facts'));
    const users = (await db.query(`INSERT INTO app_users(username,display_name,role,password_hash,status,created_at)
      VALUES ('fact-a','First maker','USER','fake','ACTIVE','2026-08-01'),
        ('fact-b','Second maker','USER','fake','ACTIVE','2026-08-01'),
        ('fact-c','Recheck maker','USER','fake','ACTIVE','2026-08-01'),
        ('fact-reviewer','Reviewer','ADMIN','fake','ACTIVE','2026-08-01') RETURNING id,username`)).rows;
    const [a, b, c, reviewer] = users;
    await db.query("INSERT INTO executor_nodes(id,name) VALUES('fact-node','Test')");
    const batch = (await db.query(`INSERT INTO production_batches(public_id,query_package_name,
      created_by_username,request_id,request_fingerprint,client_batch_code)
      VALUES($1,'same-run facts','fact-reviewer',$2,$3,$4) RETURNING id`,
    [randomUUID(), randomUUID(), 'a'.repeat(64), 'b'.repeat(32)])).rows[0].id;
    const task = (await db.query(`INSERT INTO tasks(query,input,state,created_by_node_id,
      created_by_user_id,assigned_to_user_id,assigned_at,assignment_source,production_batch_id)
      VALUES('same-run history','{}','COPY_REVIEW_PENDING','fact-node','fact-a','fact-a',
        '2026-08-02','MANUAL',$1) RETURNING id`, [batch])).rows[0].id;
    const revision = (await db.query(`INSERT INTO copy_revisions(task_id,revision,content,revision_origin)
      VALUES($1,1,'{}','GENERATION') RETURNING id`, [task])).rows[0].id;
    const run = randomUUID();
    await db.query(`INSERT INTO image_runs(id,task_id,copy_revision_id,status,result,image_production_chain_id)
      VALUES($1,$2,$3,'COMPLETED','{}',$1)`, [run, task, revision]);
    await db.query(`UPDATE tasks SET current_copy_revision_id=$2,current_image_run_id=$3,
      state='IMAGE_QC_PENDING' WHERE id=$1`, [task, revision, run]);

    async function approval(user, at, mode = 'MANDATORY_RECHECK') {
      return (await db.query(`INSERT INTO image_approval_events(task_id,copy_revision_id,image_run_id,
        submitted_by_account_id,submitted_by_username,review_session_id,image_set_sha256,
        submission_mode,submitted_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [task, revision, run, user.id, user.username, randomUUID(), 'c'.repeat(64), mode, at])).rows[0].id;
    }
    const originalApproval = await approval(a, '2026-09-01T00:00:00Z', 'SELF_REVIEW');
    await approval(b, '2026-09-01T01:00:00Z');
    const recheckApproval = await approval(c, '2026-09-01T01:00:00Z');
    await approval(a, '2026-09-01T03:00:00Z');

    const freeze = (await db.query(`INSERT INTO image_sampling_freezes(public_id,production_batch_id,
      policy_version,rate_bps,seed,algorithm_version,blind_review_enabled,submitter_account_id,
      population_count,sample_count,snapshot_sha256,frozen_by_username,request_id,close_reason)
      VALUES($1,$2,1,10000,'test','test',false,$3,1,1,$4,'fact-reviewer',$5,'MANUAL') RETURNING id`,
    [randomUUID(), batch, a.id, 'd'.repeat(64), randomUUID()])).rows[0].id;
    const originalItem = (await db.query(`INSERT INTO image_sampling_items(public_id,freeze_id,
      task_id,approval_event_id,copy_revision_id,image_run_id,image_set_sha256,submitter_account_id,
      submitter_username,rank_hash,selected,status,reviewed_at,reviewed_by_account_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'fact-a',$7,true,'PASSED','2026-09-01T00:20:00Z',$9) RETURNING id`,
    [randomUUID(), freeze, task, originalApproval, revision, run, 'e'.repeat(64), a.id, reviewer.id])).rows[0].id;
    await db.query(`INSERT INTO image_sampling_events(freeze_id,sampling_item_id,action,
      actor_account_id,actor_username,request_id,created_at)
      VALUES($1,$2,'PASS',$3,'fact-reviewer',$4,'2026-09-01T00:20:00Z')`,
    [freeze, originalItem, reviewer.id, randomUUID()]);

    async function finalReturn(at) {
      const session = randomUUID();
      await db.query(`INSERT INTO human_quality_review_submissions(review_session_id,task_id,
        stage,reviewer_username,request_fingerprint) VALUES($1,$2,'IMAGE','fact-reviewer',$3)`,
      [session, task, 'f'.repeat(64)]);
      return (await db.query(`INSERT INTO human_quality_assessments(task_id,stage,image_run_id,
        score_x10,rating_context,action,reviewer_username,review_session_id,request_fingerprint,
        rework_target,created_at) VALUES($1,'IMAGE',$2,20,'IMAGE','RETRY','fact-reviewer',$3,$4,'IMAGE',$5)
        RETURNING id`, [task, run, session, 'f'.repeat(64), at])).rows[0].id;
    }
    async function release(at, status) {
      return (await db.query(`INSERT INTO delivery_entries(task_id,copy_revision_id,image_run_id,
        status,approved_by_account_id,approved_by_username,approved_at)
        VALUES($1,$2,$3,$4,$5,'fact-reviewer',$6) RETURNING id`,
      [task, revision, run, status, reviewer.id, at])).rows[0].id;
    }
    const legacyReturn = await finalReturn('2026-09-01T00:30:00Z');
    const legacyRelease = await release('2026-09-01T00:30:00Z', 'WITHDRAWN');
    assert.equal((await db.query('SELECT count(*) FROM operator_source_facts WHERE event_key=$1',
      [`final-return:${legacyReturn}`])).rows[0].count, '4', 'the old source repeats one action for each same-run approval');
    async function storedFacts() {
      return Promise.all([
        db.query('SELECT * FROM operator_performance_events ORDER BY sequence_id'),
        db.query('SELECT * FROM account_quality_events ORDER BY sequence_id'),
        db.query('SELECT * FROM account_quality_records ORDER BY id'),
      ]).then(results => results.map(({ rows }) => rows));
    }
    const oldFacts = await storedFacts();
    await migrate(migrations);
    assert.deepEqual(await storedFacts(), oldFacts, 'the compatibility migration does not rewrite captured statistics');
    for (const key of [`final-return:${legacyReturn}`, `release:${legacyRelease}`]) {
      const source = (await db.query('SELECT * FROM operator_source_facts WHERE event_key=$1', [key])).rows;
      assert.equal(source.length, 1);
      assert.equal(source[0].account_id, a.id, 'historical actions select the approval that existed at their event time');
      assert.equal(source[0].data.approvalId, Number(originalApproval));
    }

    const returned = await finalReturn('2026-09-01T02:00:00Z');
    const released = await release('2026-09-01T02:00:00Z', 'READY');
    for (const key of [`final-return:${returned}`, `release:${released}`]) {
      const source = (await db.query('SELECT * FROM operator_source_facts WHERE event_key=$1', [key])).rows;
      assert.equal(source.length, 1);
      assert.equal(source[0].account_id, c.id, 'same-time submissions use the higher approval ID and exclude future submissions');
      assert.equal(source[0].data.approvalId, Number(recheckApproval));
      const captured = (await db.query('SELECT * FROM operator_performance_events WHERE event_key=$1', [key])).rows;
      assert.equal(captured.length, 1);
      assert.equal(captured[0].account_id, c.id);
      assert.equal(captured[0].data.approvalId, Number(recheckApproval));
    }
    assert.equal((await db.query('SELECT data FROM operator_performance_events WHERE event_key=$1',
      [`release:${released}`])).rows[0].data.releaseMethod, 'POLICY_RELEASE',
    'a passed item from the older approval does not make the recheck approval inspected');

    async function discard(item, fromState) {
      return (await db.query(`INSERT INTO image_task_dispositions(task_id,copy_revision_id,
        image_run_id,sampling_item_id,from_state,note,actor_account_id,actor_username,actor_role,
        request_id,created_at) VALUES($1,$2,$3,$4,$5,'test discard',$6,'fact-reviewer','ADMIN',$7,
          '2026-09-01T02:00:00Z') RETURNING id`,
      [task, revision, run, item, fromState, reviewer.id, randomUUID()])).rows[0].id;
    }
    const sampledDiscard = await discard(originalItem, 'IMAGE_QC_PENDING');
    const ownerDiscard = await discard(null, 'IMAGE_REWORK_PENDING');
    for (const [id, user, approvalId] of [
      [sampledDiscard, a, originalApproval], [ownerDiscard, c, recheckApproval],
    ]) {
      const key = `image-disposition:${id}`;
      const source = (await db.query('SELECT * FROM account_quality_disposition_sources WHERE event_key=$1', [key])).rows;
      assert.equal(source.length, 1);
      assert.equal(source[0].account_id, user.id);
      assert.equal(source[0].data.approvalId, Number(approvalId));
      const captured = (await db.query('SELECT * FROM account_quality_events WHERE event_key=$1', [key])).rows;
      assert.equal(captured.length, 1);
      assert.equal(captured[0].account_id, user.id);
      assert.equal(captured[0].data.approvalId, Number(approvalId));
    }
    await db.query('SELECT capture_operator_facts($1)', [task]);
    const recaptured = await storedFacts();
    for (let index = 0; index < oldFacts.length; index += 1) {
      for (const original of oldFacts[index]) {
        if (index === 2) continue; // Later decisions legitimately change the projected outcome bucket.
        assert.deepEqual(recaptured[index].find(row => row.event_key === original.event_key), original,
          'later capture does not overwrite an existing append-only fact');
      }
    }
  } finally {
    await db.end();
    await database.stop();
  }
});
