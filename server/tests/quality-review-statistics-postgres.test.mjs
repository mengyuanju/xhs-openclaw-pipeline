import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { startTemporaryPostgres18 } from './helpers/personal-postgres.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';

test('reviewer activity: real migration, event capture, pending assignment, backfill, privacy and history',{
  skip:process.env.RUN_OPERATOR_PERFORMANCE_POSTGRES!=='1',timeout:180_000,
},async()=>{
  const database=await startTemporaryPostgres18(),repository=new PostgresControlPlaneRepository({connectionString:database.connectionString});
  try {
    await repository.initialize();const db=repository.pool;
    const users=(await db.query(`INSERT INTO app_users(username,display_name,role,password_hash,status,created_at,copy_qc_enabled,image_qc_enabled)
      VALUES ('qa-maker','制作人','USER','fake','ACTIVE',now()-interval '2 days',false,false),
      ('qa-reviewer','质检同学','REVIEWER','fake','ACTIVE',now()-interval '2 days',true,true),
      ('qa-admin','管理员','ADMIN','fake','ACTIVE',now()-interval '2 days',true,true) RETURNING *`)).rows;
    const [maker,reviewer,admin]=users.map(u=>({userId:Number(u.id),username:u.username,role:u.role}));
    await db.query("INSERT INTO executor_nodes(id,name) VALUES('qa-fixture','Test')");
    const batch=Number((await db.query(`INSERT INTO production_batches(public_id,query_package_name,created_by_username,request_id,request_fingerprint,client_batch_code)
      VALUES($1,'test','qa-admin',$2,$3,$4) RETURNING id`,[randomUUID(),randomUUID(),'a'.repeat(64),'a'.repeat(32)])).rows[0].id);
    const copyFreeze=Number((await db.query(`INSERT INTO copy_sampling_freezes(public_id,production_batch_id,policy_version,rate_bps,seed,algorithm_version,blind_review_enabled,population_count,sample_count,snapshot_sha256,frozen_by_username,request_id,request_fingerprint)
      VALUES($1,$2,1,10000,'test','test',true,30,30,$3,'qa-admin',$4,$3) RETURNING id`,[randomUUID(),batch,'b'.repeat(64),randomUUID()])).rows[0].id);
    const imageFreeze=Number((await db.query(`INSERT INTO image_sampling_freezes(public_id,production_batch_id,policy_version,rate_bps,seed,algorithm_version,blind_review_enabled,submitter_account_id,population_count,sample_count,snapshot_sha256,frozen_by_username,request_id,close_reason)
      VALUES($1,$2,1,10000,'test','test',true,$3,30,30,$4,'qa-admin',$5,'MANUAL') RETURNING id`,[randomUUID(),batch,maker.userId,'c'.repeat(64),randomUUID()])).rows[0].id);
    async function sample(stage,{kind='RANDOM',task:existingTask=null,simulated=false}={}) {
      const task=existingTask??Number((await db.query(`INSERT INTO tasks(query,input,state,created_by_node_id,created_by_user_id,assigned_to_user_id,assigned_at,assignment_source,production_batch_id)
        VALUES('private producer query','{}','COPY_REVIEW_PENDING','qa-fixture','qa-maker','qa-maker',now(),'MANUAL',$1) RETURNING id`,[batch])).rows[0].id);
      const revision=Number((await db.query(`INSERT INTO copy_revisions(task_id,revision,content,revision_origin)
        SELECT $1,COALESCE(max(revision),0)+1,'{}','GENERATION' FROM copy_revisions WHERE task_id=$1 RETURNING id`,[task])).rows[0].id);
      await db.query('UPDATE tasks SET current_copy_revision_id=$2 WHERE id=$1',[task,revision]);
      const publicId=randomUUID();let item,run;
      if(stage==='COPY') {
        const approval=Number((await db.query(`INSERT INTO copy_approval_events(task_id,copy_revision_id,approval_mode,approved_by_account_id,approved_by_username,content_sha256)
          VALUES($1,$2,'MANUAL',$3,'qa-maker',$4) RETURNING id`,[task,revision,maker.userId,'d'.repeat(64)])).rows[0].id);
        await db.query("UPDATE tasks SET state='COPY_QC_PENDING' WHERE id=$1",[task]);
        item=Number((await db.query(`INSERT INTO copy_sampling_items(public_id,freeze_id,task_id,approval_event_id,copy_revision_id,content_sha256,final_approver_account_id,final_approver_username,rank_hash,selected,status,sample_kind,assigned_review_account_id,assigned_review_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,'qa-maker',$6,true,'PENDING',$8,$9,now()) RETURNING id`,[publicId,copyFreeze,task,approval,revision,'e'.repeat(64),maker.userId,kind,reviewer.userId])).rows[0].id);
      } else {
        run=randomUUID();await db.query("INSERT INTO image_runs(id,task_id,copy_revision_id,status,result,image_production_chain_id) VALUES($1,$2,$3,'COMPLETED',$4,$1)",[run,task,revision,JSON.stringify({simulation:{enabled:simulated}})]);
        await db.query("UPDATE tasks SET current_image_run_id=$2,state='IMAGE_QC_PENDING' WHERE id=$1",[task,run]);
        const approval=Number((await db.query(`INSERT INTO image_approval_events(task_id,copy_revision_id,image_run_id,submitted_by_account_id,submitted_by_username,review_session_id,image_set_sha256)
          VALUES($1,$2,$3,$4,'qa-maker',$5,$6) RETURNING id`,[task,revision,run,maker.userId,randomUUID(),'f'.repeat(64)])).rows[0].id);
        item=Number((await db.query(`INSERT INTO image_sampling_items(public_id,freeze_id,task_id,approval_event_id,copy_revision_id,image_run_id,image_set_sha256,submitter_account_id,submitter_username,rank_hash,selected,status,sample_kind,assigned_review_account_id,assigned_review_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,'qa-maker',$7,true,'PENDING',$9,$10,now()) RETURNING id`,[publicId,imageFreeze,task,approval,revision,run,'a'.repeat(64),maker.userId,kind,reviewer.userId])).rows[0].id);
      }
      return {stage,item,task,publicId,run,revision,freeze:stage==='COPY'?copyFreeze:imageFreeze};
    }
    async function decision(item,action='PASS',actor=reviewer,details={}) {
      const table=item.stage==='COPY'?'copy':'image';
      return db.query(`INSERT INTO ${table}_sampling_events(freeze_id,sampling_item_id,action,actor_account_id,actor_username,request_id,details)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,[item.freeze,item.item,action,actor.userId,actor.username,randomUUID(),details]);
    }
    const samples=[];
    for(const stage of ['COPY','COPY','COPY','COPY','COPY','IMAGE','IMAGE','IMAGE']) {
      const item=await sample(stage);samples.push(item);await decision(item);
      await db.query(`UPDATE ${stage==='COPY'?'copy':'image'}_sampling_items SET status='PASSED' WHERE id=$1`,[item.item]);
    }
    const personal=await repository.personalWorkspace(reviewer,{},true);
    assert.deepEqual(personal.notices,[]);assert.equal(personal.period.completed,0);assert.equal(personal.contribution,8);
    assert.equal(personal.qa.reviews,8);assert.equal(personal.qa.COPY.reviews,5);assert.equal(personal.qa.IMAGE.reviews,3);
    let report=await repository.operatorPerformance(admin,{});
    assert.deepEqual(report.people.items.find(p=>p.accountId===reviewer.userId).qa,personal.qa);
    const history=await repository.personalQualityActivity(reviewer,{metric:'qa'});
    assert.equal(history.total,8);assert.equal(history.items[0].query,undefined);assert.equal(history.items[0].taskId,undefined);
    assert.equal(history.items[0].accountId,undefined);assert.equal(history.items[0].copyRevisionId,undefined);
    await assert.rejects(repository.personalQualityActivity(reviewer,{accountId:String(maker.userId)}),/筛选/);
    const pending=await sample('COPY');
    let current=await repository.personalWorkspace(reviewer,{period:'custom',from:'2020-01-01',to:'2020-01-01'},true);
    assert.equal(current.qa.reviews,0);assert.equal(current.qa.pending,1);
    await db.query("UPDATE tasks SET priority_mode='PAUSE' WHERE id=$1",[pending.task]);
    current=await repository.personalWorkspace(reviewer,{},true);assert.equal(current.qa.pending,0);assert.equal(current.qa.blocked,1);
    assert.equal((await repository.personalQualityActivity(reviewer,{metric:'qaBlocked'})).total,1);
    await db.query("UPDATE tasks SET priority_mode='SYSTEM' WHERE id=$1",[pending.task]);
    await decision(pending,'RETURN_SINGLE');
    await decision(pending,'RETURN_BATCH',admin,{affectedCount:2,affectedTaskIds:[samples[0].task,samples[1].task]});
    report=await repository.operatorPerformance(admin,{activity:'QA'});
    assert.equal(report.people.items.find(p=>p.accountId===reviewer.userId).qa.reviews,9);
    assert.equal(report.people.items.find(p=>p.accountId===admin.userId).qa.reviews,0);
    assert.equal(report.people.items.find(p=>p.accountId===admin.userId).qa.batchActions,1);
    const trigger=await sample('COPY');await decision(trigger,'RETURN_BATCH',admin,{affectedCount:1});
    const imageBatch={stage:'IMAGE',freeze:imageFreeze,item:null};await decision(imageBatch,'RETURN_BATCH',reviewer,{affectedCount:25});
    const direct=await sample('COPY');await decision(direct,'PASS',admin,{directAdminApproval:true});
    const discarded=await sample('IMAGE');await decision(discarded,'DISCARD',reviewer,{fromState:'IMAGE_QC_PENDING'});
    const fake=await sample('IMAGE',{simulated:true});await decision(fake);
    const recheck=await sample('COPY',{kind:'MANDATORY_RECHECK',task:samples[0].task});await decision(recheck);
    report=await repository.operatorPerformance(admin,{activity:'QA'});
    const reviewerRow=report.people.items.find(p=>p.accountId===reviewer.userId),adminRow=report.people.items.find(p=>p.accountId===admin.userId);
    assert.equal(reviewerRow.qa.reviews,10);assert.equal(reviewerRow.qa.rechecks,1);assert.equal(reviewerRow.qa.tasks,9);
    assert.equal(reviewerRow.qa.discarded,1);assert.equal(reviewerRow.qa.legacyAffectedCount,25);
    assert.equal(adminRow.qa.reviews,1);assert.equal(adminRow.qa.directPass,1);assert.equal(adminRow.qa.batchActions,2);
    const before=Number((await db.query('SELECT count(*) FROM quality_review_activity_events')).rows[0].count);
    await db.query('SELECT capture_quality_review_activity()');
    assert.equal(Number((await db.query('SELECT count(*) FROM quality_review_activity_events')).rows[0].count),before);
    // Rebuild only this isolated test ledger from source events to verify backfill.
    await db.query('TRUNCATE quality_review_activity_events');await db.query('SELECT capture_quality_review_activity()');
    assert.equal(Number((await db.query('SELECT count(*) FROM quality_review_activity_events')).rows[0].count),before);
    const rollbackItem=await sample('COPY'),client=await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO copy_sampling_events(freeze_id,sampling_item_id,action,actor_account_id,actor_username,request_id)
        VALUES($1,$2,'PASS',$3,$4,$5)`,[rollbackItem.freeze,rollbackItem.item,reviewer.userId,reviewer.username,randomUUID()]);
      assert.equal(Number((await client.query('SELECT count(*) FROM quality_review_activity_events')).rows[0].count),before+1);
      await client.query('ROLLBACK');
    } finally {client.release();}
    assert.equal(Number((await db.query('SELECT count(*) FROM quality_review_activity_events')).rows[0].count),before);
    await db.query('DELETE FROM tasks WHERE id=$1',[samples[0].task]);
    const retained=await repository.personalWorkspace(reviewer,{},true);assert.equal(retained.qa.reviews,10);
    const snapshot=await repository.operatorPerformance(admin,{snapshotToken:report.snapshotToken},{kind:'export'});
    assert.match(snapshot.csv,/质检同学/);assert.match(snapshot.csv,/文案质检次数/);
    await assert.rejects(repository.operatorPerformance(admin,{snapshotToken:report.snapshotToken,activity:'PRODUCTION'}),/筛选/);
    const editing=await sample('IMAGE');
    const asset=Number((await db.query(`INSERT INTO assets(task_id,image_run_id,media_type,byte_size,sha256,storage_path,image_production_chain_id,origin_image_run_id,artifact_key)
      VALUES($1,$2,'image/png',10,$3,'fake.png',$2,$2,'fake') RETURNING id`,[editing.task,editing.run,'f'.repeat(64)])).rows[0].id);
    await db.query(`INSERT INTO image_edit_requests(id,task_id,request_id,source_image_run_id,source_asset_id,copy_revision_id,source_sha256,target_page,operation,config,status,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,1,'TEXT','{}','DRAFT','qa-maker')`,[randomUUID(),editing.task,randomUUID(),editing.run,asset,editing.revision,'f'.repeat(64)]);
    const receipt=(await repository.personalQualityActivity(reviewer,{metric:'qaPending',stage:'IMAGE'})).items.find(row=>row.id===`qa-pending:IMAGE:${editing.item}`);
    assert.equal(receipt.passBlocked,true);assert.equal(receipt.blocked,false,'pending edits block pass but still allow return, so retain reviewer workload');
  } finally {await repository.pool.end();await database.stop();}
});
