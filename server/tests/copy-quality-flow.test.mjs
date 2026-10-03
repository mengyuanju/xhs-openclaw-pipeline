import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { planCopyQualityChunk, copyQualityImageGate } from '../src/copy-quality-flow.mjs';
import { startTemporaryPostgres18 } from './temporary-postgres18.mjs';

const RUN_POSTGRES_E2E = process.env.RUN_POSTGRES_E2E === '1';

test('legacy sampling integer boundaries, full inspection, closing tails and per-account carry', () => {
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

// New approvals use V2 personal batches. Legacy production freezes and manual
// whole-batch actions are retired; keep all gate, replay and permission checks
// against the production V2 route rather than simulating the removed workflow.
test('real PostgreSQL V2 quality flow: account isolation, replay, automatic batch return, mandatory recheck and final gate', {
  skip: !RUN_POSTGRES_E2E, timeout: 180_000,
}, async t => {
  const { default: pg } = await import('pg');
  const { applyMigrations, loadMigrations } = await import('../src/database-migrations.mjs');
  const { routeManualCopyApproval } = await import('../src/copy-quality-control.mjs');
  const { createCopyQaBatchV2, decideCopyQaItemV2, listCopyQaBatchItemsV2 } = await import('../src/copy-qa-v2.mjs');
  const { PostgresControlPlaneRepository } = await import('../src/postgres-repository.mjs');
  const temporary = await startTemporaryPostgres18('xhs-copy-quality-v2-');
  const pool = new pg.Pool({ connectionString: temporary.connectionString, max: 4 });
  t.after(async () => { await pool.end(); await temporary.stop(); });
  async function tx(action) {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const result = await action(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  await tx(async client => applyMigrations(client, await loadMigrations()));
  await pool.query("INSERT INTO executor_nodes(id,name) VALUES ('qc-test','test')");
  const actors = [];
  for (const username of ['alice','bob','inspector']) {
    const row = (await pool.query(`INSERT INTO app_users(username,display_name,role,password_hash,
      copy_review_enabled,copy_qc_enabled,auto_copy_batch_size)
      VALUES($1,$1,'REVIEWER','not-a-credential',true,true,5) RETURNING *`,[username])).rows[0];
    actors.push({ userId:Number(row.id),username,role:'REVIEWER',credentialVersion:1 });
  }
  const [alice,bob,inspector] = actors;
  const admin = {userId:1,username:'admin',role:'ADMIN',credentialVersion:1};
  await pool.query(`UPDATE workflow_quality_settings SET copy_sampling_enabled=true,
    copy_sampling_rate_bps=2000,blind_review_enabled=true,copy_batch_return_threshold_bps=5000`);
  const tasks = [];
  for (let index=0;index<12;index++) {
    const actor = index<6?alice:bob;
    const task = (await pool.query(`INSERT INTO tasks(query,created_by_node_id,state,
      assigned_to_user_id,assignment_source,assigned_at)
      VALUES($1,'qc-test','COPY_REVIEW_PENDING',$2,'MANUAL',now()) RETURNING *`,
    [`test ${index}`,actor.username])).rows[0];
    const revision = (await pool.query(`INSERT INTO copy_revisions(task_id,revision,content,approved_at)
      VALUES($1,1,$2,now()) RETURNING *`,[task.id,
      {copy:{title:`test ${index}`,body:'approved final content',tags:[]}}])).rows[0];
    await pool.query('UPDATE tasks SET current_copy_revision_id=$2 WHERE id=$1',[task.id,revision.id]);
    task.current_copy_revision_id=revision.id;
    tasks.push({task,revision,actor});
  }
  const approve = entry => tx(client => routeManualCopyApproval(client,
    {...entry,reviewSessionId:randomUUID(),aiDisclosureEnabled:false}));
  for (const entry of tasks.slice(0,5)) await approve(entry);
  for (const entry of tasks.slice(6,11)) await approve(entry);
  const batches = (await pool.query('SELECT * FROM copy_qa_batches_v2 ORDER BY id')).rows;
  assert.equal(batches.length,2);
  assert.deepEqual(batches.map(row=>[Number(row.account_id),row.member_count,row.sample_count]),
    [[alice.userId,5,1],[bob.userId,5,1]]);
  const itemOf = async batch => (await pool.query(`SELECT * FROM copy_qa_batch_members_v2
    WHERE batch_id=$1 AND selected ORDER BY id`,[batch.id])).rows[0];
  const decision = (item,value,extra={}) => decideCopyQaItemV2(pool,item.public_id,
    {decision:value,requestId:randomUUID(),revisionToken:item.content_sha256,...extra},inspector);
  const aliceItem = await itemOf(batches[0]);
  const adminDetail = await listCopyQaBatchItemsV2(pool,batches[0].public_id,admin);
  assert.equal(adminDetail.items[0].taskId,Number(aliceItem.task_id));
  assert.equal(adminDetail.items[0].approverUsername,'alice');
  const blind = await listCopyQaBatchItemsV2(pool,batches[0].public_id,inspector);
  assert.equal(blind.items[0].taskId,null);
  assert.equal(blind.items[0].query,null);
  assert.equal(blind.items[0].approverUsername,null);
  await pool.query('UPDATE app_users SET copy_qc_enabled=false WHERE id=$1',[inspector.userId]);
  await assert.rejects(decision(aliceItem,'PASS'),{code:'FORBIDDEN'});
  await pool.query('UPDATE app_users SET copy_qc_enabled=true WHERE id=$1',[inspector.userId]);
  await assert.rejects(decideCopyQaItemV2(pool,aliceItem.public_id,
    {decision:'PASS',requestId:randomUUID(),revisionToken:aliceItem.content_sha256},
    {...inspector,credentialVersion:99}),{code:'SESSION_STALE'});
  const requestId=randomUUID();
  const input={decision:'PASS',requestId,revisionToken:aliceItem.content_sha256};
  const [passed,replayed]=await Promise.all([1,2].map(()=>decideCopyQaItemV2(pool,aliceItem.public_id,input,inspector)));
  assert.deepEqual(replayed,passed);
  assert.deepEqual(await decideCopyQaItemV2(pool,aliceItem.public_id,input,inspector),passed);
  assert.equal(Number((await pool.query('SELECT count(*) FROM copy_qa_decision_requests_v2 WHERE request_id=$1',[requestId])).rows[0].count),1);
  assert.equal(Number((await pool.query("SELECT count(*) FROM tasks WHERE state='IMAGE_QUEUED' AND assigned_to_user_id='alice'")).rows[0].count),5);
  assert.equal((await pool.query('SELECT status FROM copy_qa_batches_v2 WHERE id=$1',[batches[0].id])).rows[0].status,'COMPLETED');
  const bobItem=await itemOf(batches[1]);
  const returnedInput={decision:'RETURN',requestId:randomUUID(),revisionToken:bobItem.content_sha256,note:'incorrect copy'};
  await decideCopyQaItemV2(pool,bobItem.public_id,returnedInput,inspector);
  await decideCopyQaItemV2(pool,bobItem.public_id,returnedInput,inspector);
  assert.equal((await pool.query('SELECT status FROM copy_qa_batches_v2 WHERE id=$1',[batches[1].id])).rows[0].status,'AUTO_RETURNED');
  const returned=(await pool.query("SELECT * FROM tasks WHERE copy_qa_rework_pending ORDER BY id")).rows;
  assert.equal(returned.length,5);
  assert.deepEqual([...new Set(returned.map(row=>row.assigned_to_user_id))],['bob']);
  assert.deepEqual([...new Set(returned.map(row=>row.state))],['COPY_REVIEW_PENDING']);
  assert.equal(Number((await pool.query('SELECT count(*) FROM copy_qa_return_events_v2')).rows[0].count),5);
  await assert.rejects(decision(bobItem,'PASS'),error=>['BATCH_CLOSED','STALE_QA_ITEM'].includes(error.code));
  for (const task of returned) {
    const old=(await pool.query('SELECT * FROM copy_revisions WHERE id=$1',[task.current_copy_revision_id])).rows[0];
    const revision=(await pool.query(`INSERT INTO copy_revisions(task_id,revision,parent_revision_id,content,
      approved_at,revision_origin) VALUES($1,$2,$3,$4,now(),'COPY_EDIT') RETURNING *`,
    [task.id,Number(old.revision)+1,old.id,{copy:{title:'repaired',body:'corrected final copy',tags:[]}}])).rows[0];
    const routed=await approve({task,revision,actor:bob});
    assert.equal(routed.task.state,'COPY_QC_PENDING');
    assert.equal(routed.task.mandatory_copy_qc,true);
  }
  const rechecks=(await pool.query(`SELECT member.*,batch.full_inspection,batch.sample_count
    FROM copy_qa_batch_members_v2 member JOIN copy_qa_batches_v2 batch ON batch.id=member.batch_id
    WHERE batch.id> $1 ORDER BY member.id`,[batches[1].id])).rows;
  assert.equal(rechecks.length,5);
  for (const [index,item] of rechecks.entries()) {
    assert.equal(item.full_inspection,true);
    assert.equal(item.sample_count,1);
    assert.equal(item.selected,true);
    await decision(item,'PASS');
    assert.equal(Number((await pool.query("SELECT count(*) FROM tasks WHERE state='IMAGE_QUEUED' AND assigned_to_user_id='bob'")).rows[0].count),index+1,
      'V2 passed rechecks release each inspected final revision immediately');
  }
  assert.equal(Number((await pool.query(`SELECT count(*) FROM tasks task WHERE ${copyQualityImageGate('task')}`)).rows[0].count),10);
  const changed=tasks.find(entry=>Number(entry.task.id)===Number(aliceItem.task_id)).task;
  await pool.query('UPDATE tasks SET mandatory_copy_qc=true WHERE id=$1',[changed.id]);
  assert.equal((await pool.query(`SELECT ${copyQualityImageGate('task')} AS ok FROM tasks task WHERE id=$1`,[changed.id])).rows[0].ok,false);
  await pool.query('UPDATE tasks SET mandatory_copy_qc=false WHERE id=$1',[changed.id]);
  await assert.rejects(pool.query('UPDATE copy_revisions SET content=$2 WHERE id=$1',
    [changed.current_copy_revision_id,{copy:{title:'tampered'}}]),{code:'23514'});
  const tail=tasks[5];
  await approve(tail);
  const manual=await createCopyQaBatchV2(pool,{mode:'PERSONAL_MANUAL',accountId:alice.userId,
    taskIds:[Number(tail.task.id)],sampleTaskIds:[Number(tail.task.id)],requestId:randomUUID()},admin);
  const manualBatch=(await pool.query('SELECT * FROM copy_qa_batches_v2 WHERE public_id=$1',[manual.id])).rows[0];
  const single=await itemOf(manualBatch);
  await decision(single,'RETURN',{note:'single correction'});
  assert.equal((await pool.query('SELECT copy_qa_rework_pending FROM tasks WHERE id=$1',[single.task_id])).rows[0].copy_qa_rework_pending,true);
  const repository=new PostgresControlPlaneRepository({pool});
  await repository.updateUser(alice.userId,{displayName:'alice',role:'REVIEWER',status:'ACTIVE',expectedVersion:1,
    copyReviewEnabled:false,copyQcEnabled:true,actorUsername:'admin'});
  assert.equal((await pool.query('SELECT assigned_to_user_id FROM tasks WHERE id=$1',[single.task_id])).rows[0].assigned_to_user_id,null);
  assert.equal(Number((await pool.query('SELECT count(*) FROM copy_quality_permission_events WHERE account_id=$1',[alice.userId])).rows[0].count),1);
  await assert.rejects(pool.query("UPDATE tasks SET assigned_to_user_id='alice',assignment_source='MANUAL',assigned_at=now() WHERE id=$1",
    [tasks[11].task.id]),{code:'23514'});
});
