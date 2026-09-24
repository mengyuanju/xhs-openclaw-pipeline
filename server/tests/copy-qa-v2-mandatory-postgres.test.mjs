import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { autoCreateCopyQaBatchesV2, createCopyQaBatchV2, decideCopyQaItemV2 } from '../src/copy-qa-v2.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { startTemporaryPostgres18 } from './helpers/personal-postgres.mjs';

test('manual and automatic batches select mandatory legacy candidates and refuse unreviewed release', {
  skip:process.env.RUN_POSTGRES_E2E!=='1',timeout:180_000,
},async()=>{
  const database=await startTemporaryPostgres18();
  const repository=new PostgresControlPlaneRepository({connectionString:database.connectionString});
  const db=repository.pool;
  try{
    await repository.initialize();
    await db.query("INSERT INTO executor_nodes(id,name) VALUES('copy-qa-v2-node','Test Node')");
    const accounts=(await db.query(`INSERT INTO app_users(username,display_name,role,password_hash,status,
      copy_review_enabled,copy_qc_enabled)
      VALUES('copy-qa-v2-admin','Admin','ADMIN','test-only','ACTIVE',true,true),
        ('copy-qa-v2-worker','Worker','USER','test-only','ACTIVE',true,false),
        ('copy-qa-v2-reviewer','Reviewer','REVIEWER','test-only','ACTIVE',false,true)
      RETURNING id,username,role,credential_version`)).rows;
    const [admin,worker,reviewer]=accounts.map(row=>({userId:Number(row.id),username:row.username,
      role:row.role,credentialVersion:Number(row.credential_version)}));
    async function candidate({mandatory=true}={}){
      const taskId=Number((await db.query(`INSERT INTO tasks(query,input,state,created_by_node_id,
        assigned_to_user_id,assignment_source,assigned_at,mandatory_copy_qc,mandatory_copy_qc_origin)
        VALUES('候选任务','{}','COPY_QC_PENDING','copy-qa-v2-node',$1,'MANUAL',now(),$2,$3)
        RETURNING id`,[worker.username,mandatory,mandatory?'QA_RETURN':null])).rows[0].id);
      const revisionId=Number((await db.query(`INSERT INTO copy_revisions(task_id,revision,content,revision_origin,approved_at)
        VALUES($1,1,$2,'GENERATION',now()) RETURNING id`,[taskId,
        {copy:{title:'测试文案',body:'待质检文案',tags:['#测试']},imagePlan:[]}])).rows[0].id);
      await db.query('UPDATE tasks SET current_copy_revision_id=$2 WHERE id=$1',[taskId,revisionId]);
      await db.query(`INSERT INTO copy_approval_events(task_id,copy_revision_id,approval_mode,
        approved_by_account_id,approved_by_username,content_sha256)
        VALUES($1,$2,'MANUAL',$3,$4,$5)`,[taskId,revisionId,worker.userId,worker.username,'a'.repeat(64)]);
      return taskId;
    }
    async function member(taskId){
      return (await db.query(`SELECT member.*,batch.member_count,batch.sample_count,
        batch.full_inspection,batch.status AS batch_status
        FROM copy_qa_batch_members_v2 AS member
        JOIN copy_qa_batches_v2 AS batch ON batch.id=member.batch_id
        WHERE member.task_id=$1 ORDER BY member.id DESC LIMIT 1`,[taskId])).rows[0];
    }

    const manual=await candidate();
    await createCopyQaBatchV2(db,{mode:'PERSONAL_MANUAL',accountId:worker.userId,
      taskIds:[manual],sampleTaskIds:[],requestId:randomUUID()},admin);
    const manualMember=await member(manual);
    assert.equal(manualMember.selected,true);
    assert.equal(manualMember.status,'PENDING');
    assert.equal(manualMember.sample_count,1);

    await db.query('UPDATE workflow_quality_settings SET copy_sampling_enabled=true,copy_sampling_rate_bps=0');
    await db.query('UPDATE app_users SET auto_copy_batch_enabled=true,auto_copy_batch_size=1 WHERE id=$1',[worker.userId]);
    const automatic=await candidate();
    const client=await db.connect();
    try{
      await client.query('BEGIN');
      await autoCreateCopyQaBatchesV2(client,worker.userId);
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}
    finally{client.release();}
    const automaticMember=await member(automatic);
    assert.equal(automaticMember.selected,true);
    assert.equal(automaticMember.status,'PENDING');
    assert.equal(automaticMember.sample_count,1);

    const protectedTask=await candidate();
    const returnedTask=await candidate({mandatory:false});
    await createCopyQaBatchV2(db,{mode:'PERSONAL_MANUAL',accountId:worker.userId,
      taskIds:[protectedTask,returnedTask],sampleTaskIds:[returnedTask],requestId:randomUUID()},admin);
    const protectedMember=await member(protectedTask);
    const returnedMember=await member(returnedTask);
    assert.equal(protectedMember.full_inspection,true);
    await decideCopyQaItemV2(db,returnedMember.public_id,{
      requestId:randomUUID(),revisionToken:returnedMember.content_sha256,
      decision:'RETURN',note:'普通成员质检打回',
    },reviewer);
    assert.equal((await member(protectedTask)).status,'PENDING');
    assert.equal((await member(protectedTask)).batch_status,'INSPECTING',
      'the return threshold cannot auto-return an unreviewed mandatory member');
    assert.equal((await db.query('SELECT state FROM tasks WHERE id=$1',
      [protectedTask])).rows[0].state,'COPY_QC_PENDING');

    const guarded=await candidate();
    const ordinary=await candidate({mandatory:false});
    await createCopyQaBatchV2(db,{mode:'PERSONAL_MANUAL',accountId:worker.userId,
      taskIds:[guarded,ordinary],sampleTaskIds:[ordinary],requestId:randomUUID()},admin);
    const guardedMember=await member(guarded);
    const ordinaryMember=await member(ordinary);
    assert.equal(guardedMember.selected,true);
    assert.equal(ordinaryMember.selected,true);
    await db.query("UPDATE copy_qa_batch_members_v2 SET selected=false,status='NOT_SELECTED' WHERE id=$1",
      [guardedMember.id]);
    await assert.rejects(decideCopyQaItemV2(db,ordinaryMember.public_id,{
      requestId:randomUUID(),revisionToken:ordinaryMember.content_sha256,decision:'PASS',
    },reviewer),{code:'STALE_QA_ITEM'});
    assert.equal((await db.query('SELECT state FROM tasks WHERE id=$1',[guarded])).rows[0].state,'COPY_QC_PENDING');
    assert.equal((await db.query('SELECT status FROM copy_qa_batch_members_v2 WHERE id=$1',
      [ordinaryMember.id])).rows[0].status,'PENDING','failed batch completion rolls back the verdict');
  }finally{await db.end();await database.stop();}
});
