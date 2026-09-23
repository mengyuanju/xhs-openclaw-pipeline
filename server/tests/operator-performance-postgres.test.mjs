import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { startTemporaryPostgres18 } from './helpers/personal-postgres.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';

test('operator report: real SQL, immutable identity, sampling denominator, snapshots and elapsed time',{
  skip:process.env.RUN_OPERATOR_PERFORMANCE_POSTGRES!=='1',timeout:180_000,
},async()=>{
  const database=await startTemporaryPostgres18();
  const repository=new PostgresControlPlaneRepository({connectionString:database.connectionString});
  try{
    await repository.initialize();
    const db=repository.pool;
    const users=(await db.query(`INSERT INTO app_users(username,display_name,role,password_hash,status,created_at)
      VALUES ('perf-a','标注甲','USER','fake-only','ACTIVE',now()-interval '5 days'),
      ('perf-b','标注乙','USER','fake-only','ACTIVE',now()-interval '5 days'),
      ('perf-admin','管理员','ADMIN','fake-only','ACTIVE',now()-interval '5 days'),
      ('perf-idle','空闲甲','USER','fake-only','ACTIVE',now()-interval '5 days'),
      ('perf-disabled','已停用甲','USER','fake-only','DISABLED',now()-interval '5 days') RETURNING *`)).rows;
    const [a,b,admin]=users.map(row=>({userId:Number(row.id),username:row.username,role:row.role}));
    const [idle,disabled]=users.slice(3).map(row=>({userId:Number(row.id),username:row.username}));
    await db.query("INSERT INTO executor_nodes(id,name) VALUES('perf-node','Test')");
    const batch=Number((await db.query(`INSERT INTO production_batches(public_id,query_package_name,created_by_username,request_id,request_fingerprint,client_batch_code)
      VALUES($1,'统计测试','perf-admin',$2,$3,$4) RETURNING id`,[randomUUID(),randomUUID(),'a'.repeat(64),'b'.repeat(32)])).rows[0].id);
    const tasks=[];
    for(let i=0;i<10;i++){
      const task=Number((await db.query(`INSERT INTO tasks(query,input,state,created_by_node_id,created_by_user_id,assigned_to_user_id,assigned_at,assignment_source,production_batch_id)
        VALUES($1,'{}','COPY_REVIEW_PENDING','perf-node','perf-a','perf-a',now(),'MANUAL',$2) RETURNING id`,[`test ${i}`,batch])).rows[0].id);
      const revision=Number((await db.query("INSERT INTO copy_revisions(task_id,revision,content,revision_origin) VALUES($1,1,'{}','GENERATION') RETURNING id",[task])).rows[0].id);
      await db.query('UPDATE tasks SET current_copy_revision_id=$2 WHERE id=$1',[task,revision]);
      // Give each task a complete, known cycle without consuming time or model quota.
      await db.query("UPDATE operator_stage_events SET occurred_at=clock_timestamp()-interval '10 minutes' WHERE task_id=$1",[task]);
      const approval=Number((await db.query(`INSERT INTO copy_approval_events(task_id,copy_revision_id,approval_mode,approved_by_account_id,approved_by_username,content_sha256)
        VALUES($1,$2,'MANUAL',$3,'perf-a',$4) RETURNING id`,[task,revision,a.userId,'c'.repeat(64)])).rows[0].id);
      tasks.push({task,revision,approval});
    }
    const freeze=Number((await db.query(`INSERT INTO copy_sampling_freezes(public_id,production_batch_id,policy_version,rate_bps,seed,algorithm_version,blind_review_enabled,population_count,sample_count,snapshot_sha256,frozen_by_username,request_id,request_fingerprint)
      VALUES($1,$2,1,4000,'test','test',false,10,4,$3,'perf-admin',$4,$5) RETURNING id`,[randomUUID(),batch,'d'.repeat(64),randomUUID(),'e'.repeat(64)])).rows[0].id);
    for(let i=0;i<10;i++){
      const t=tasks[i];
      const item=Number((await db.query(`INSERT INTO copy_sampling_items(public_id,freeze_id,task_id,approval_event_id,copy_revision_id,content_sha256,final_approver_account_id,final_approver_username,rank_hash,selected,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,'perf-a',$6,$8,$9) RETURNING id`,[randomUUID(),freeze,t.task,t.approval,t.revision,'f'.repeat(64),a.userId,i<4,i<4?'PENDING':'NOT_SELECTED'])).rows[0].id);
      t.item=item;
      if(i<4){
        const action=i===3?'RETURN_SINGLE':'PASS';
        await db.query("UPDATE copy_sampling_items SET status=$2,reviewed_at=now(),reviewed_by_account_id=$3 WHERE id=$1",[item,i===3?'RETURNED':'PASSED',admin.userId]);
        await db.query(`INSERT INTO copy_sampling_events(freeze_id,sampling_item_id,action,actor_account_id,actor_username,request_id)
          VALUES($1,$2,$3,$4,'perf-admin',$5)`,[freeze,item,action,admin.userId,randomUUID()]);
      }
    }
    await db.query(`INSERT INTO copy_sampling_events(freeze_id,action,actor_account_id,actor_username,request_id)
      VALUES($1,'FREEZE',$2,'perf-admin',$3)`,[freeze,admin.userId,randomUUID()]);
    let report=await repository.operatorPerformance(admin,{});
    for(const account of [idle,disabled]) {
      const row=report.people.items.find(person=>person.accountId===account.userId);
      assert.ok(row,`${account.username} appears with zero activity`);
      assert.equal(row.contributed,0);
      assert.equal(row.qa.passed+row.qa.returned,0);
      assert.equal(row.qualityOutcomes.judged,0);
    }
    assert.equal(report.people.total,Number((await db.query('SELECT count(*) FROM app_users')).rows[0].count));
    const idleScoped=await repository.operatorPerformance(admin,{accountId:String(idle.userId)});
    assert.deepEqual(idleScoped.people.items.map(person=>person.accountId),[idle.userId]);
    const idleSearched=await repository.operatorPerformance(admin,{query:'空闲甲'});
    assert.deepEqual(idleSearched.people.items.map(person=>person.accountId),[idle.userId]);
    const qaOnly=await repository.operatorPerformance(admin,{activity:'QA'});
    assert.equal(qaOnly.people.items.some(person=>person.accountId===idle.userId),false);
    assert.equal(qaOnly.people.items.some(person=>person.accountId===disabled.userId),false);
    assert.equal(report.summary.COPY.submitted,10);
    assert.deepEqual(report.summary.COPY.coverage,{eligible:10,sampled:4,unresolved:0,rate:.4});
    assert.deepEqual(report.summary.COPY.firstPass,{passed:3,failed:1,decided:4,rate:.75});
    assert.equal(report.summary.COPY.duration.samples,10);
    assert.ok(report.summary.COPY.duration.medianMs>=599_000);
    const person=report.people.items.find(row=>row.accountId===a.userId);
    assert.equal(person.COPY.firstPass.rate,.75);
    const details=await repository.operatorPerformance(admin,{snapshotToken:report.snapshotToken,metric:'firstPass',stage:'COPY'},{kind:'detail',accountId:a.userId});
    assert.equal(details.total,4);
    const personal=await repository.personalWorkspace(a,{},true);
    assert.equal(personal.quality.COPY.rate,.75);
    await assert.rejects(repository.operatorPerformance(admin,{snapshotToken:report.snapshotToken,accountId:String(b.userId)}),/筛选条件/);
    await db.query("UPDATE tasks SET assigned_to_user_id='perf-b',assigned_at=now() WHERE id=$1",[tasks[0].task]);
    await db.query("UPDATE copy_sampling_items SET status='SUPERSEDED' WHERE id=$1",[tasks[3].item]);
    report=await repository.operatorPerformance(admin,{});
    assert.equal(report.people.items.find(row=>row.accountId===a.userId).COPY.firstPass.rate,.75);
    assert.equal(report.people.items.find(row=>row.accountId===b.userId).COPY.submitted,0);
    assert.equal(report.people.items.find(row=>row.accountId===b.userId).pending,1);
    await assert.rejects(repository.operatorPerformance(a,{}),/管理员/);
    await assert.rejects(repository.operatorPerformance({...admin,userId:admin.userId+100},{snapshotToken:report.snapshotToken}),/快照/);
    // Later samples cannot mutate the saved report or export.
    const csv=await repository.operatorPerformance(admin,{snapshotToken:report.snapshotToken},{kind:'export'});
    assert.match(csv.csv,/文案通过/);
    assert.match(csv.csv,/标注甲/);
    assert.match(csv.csv,/空闲甲/);
    assert.match(csv.csv,/已停用甲/);
    const before=(await db.query('SELECT count(*) FROM operator_performance_events')).rows[0].count;
    await db.query('SELECT capture_operator_facts()');
    assert.equal((await db.query('SELECT count(*) FROM operator_performance_events')).rows[0].count,before);
    const timingBefore=(await db.query('SELECT count(*) FROM operator_stage_events WHERE task_id=$1',[tasks[1].task])).rows[0].count;
    await db.query('UPDATE tasks SET updated_at=now(),last_activity_at=now() WHERE id=$1',[tasks[1].task]);
    assert.equal((await db.query('SELECT count(*) FROM operator_stage_events WHERE task_id=$1',[tasks[1].task])).rows[0].count,timingBefore);
    // Repair by another worker: the original failed sample stays with A;
    // B receives the repair and first recheck, never a new first-pass sample.
    const original=tasks[3];
    const repair=Number((await db.query(`INSERT INTO copy_revisions(task_id,revision,content,revision_origin,parent_revision_id)
      VALUES($1,2,'{}','QA_RETURN',$2) RETURNING id`,[original.task,original.revision])).rows[0].id);
    await db.query("UPDATE tasks SET assigned_to_user_id='perf-b',assigned_at=now(),current_copy_revision_id=$2 WHERE id=$1",[original.task,repair]);
    const repairedApproval=Number((await db.query(`INSERT INTO copy_approval_events(task_id,copy_revision_id,approval_mode,approved_by_account_id,approved_by_username,content_sha256)
      VALUES($1,$2,'MANUAL',$3,'perf-b',$4) RETURNING id`,[original.task,repair,b.userId,'a'.repeat(64)])).rows[0].id);
    const recheckFreeze=Number((await db.query(`INSERT INTO copy_sampling_freezes(public_id,production_batch_id,freeze_version,policy_version,rate_bps,seed,algorithm_version,blind_review_enabled,population_count,sample_count,snapshot_sha256,frozen_by_username,request_id,request_fingerprint)
      VALUES($1,$2,2,1,10000,'test','test',false,1,1,$3,'perf-admin',$4,$5) RETURNING id`,[randomUUID(),batch,'d'.repeat(64),randomUUID(),'e'.repeat(64)])).rows[0].id);
    const recheck=Number((await db.query(`INSERT INTO copy_sampling_items(public_id,freeze_id,task_id,approval_event_id,copy_revision_id,content_sha256,final_approver_account_id,final_approver_username,rank_hash,selected,status,sample_kind,parent_item_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,'perf-b',$6,true,'PENDING','MANDATORY_RECHECK',$8) RETURNING id`,[randomUUID(),recheckFreeze,original.task,repairedApproval,repair,'f'.repeat(64),b.userId,original.item])).rows[0].id);
    await db.query("UPDATE copy_sampling_items SET status='PASSED',reviewed_at=now(),reviewed_by_account_id=$2 WHERE id=$1",[recheck,admin.userId]);
    await db.query(`INSERT INTO copy_sampling_events(freeze_id,sampling_item_id,action,actor_account_id,actor_username,request_id)
      VALUES($1,$2,'PASS',$3,'perf-admin',$4)`,[recheckFreeze,recheck,admin.userId,randomUUID()]);
    const repaired=await repository.operatorPerformance(admin,{});
    assert.equal(repaired.summary.COPY.firstPass.rate,.75);
    assert.deepEqual(repaired.people.items.find(row=>row.accountId===a.userId).COPY.overallPass,
      {passed:4,failed:0,decided:4,rate:1});
    const scoped=await repository.operatorPerformance(admin,{accountId:String(a.userId)});
    assert.deepEqual(scoped.summary.COPY.overallPass,{passed:4,failed:0,decided:4,rate:1},
      'another worker recheck still counts for the original account after SQL account filtering');
    assert.equal(scoped.people.items.length,1);
    const searched=await repository.operatorPerformance(admin,{query:'标注甲'});
    assert.deepEqual(searched.summary.COPY.overallPass,{passed:4,failed:0,decided:4,rate:1},
      'name search keeps cross-account recheck history without showing that account');
    assert.equal(searched.people.items.length,1);
    const bReport=repaired.people.items.find(row=>row.accountId===b.userId);
    assert.equal(bReport.COPY.firstPass.decided,0);assert.equal(bReport.COPY.recheck.rate,1);assert.equal(bReport.COPY.firstRecheck.rate,1);
    assert.equal(bReport.reworkRounds,1);assert.equal(bReport.reworkDuration.samples,1);
    const frozen=await repository.operatorPerformance(admin,{snapshotToken:report.snapshotToken,metric:'recheck'},{kind:'detail',accountId:b.userId});
    assert.equal(frozen.total,0,'saved snapshot does not incorporate later conclusions');
    await db.query('DELETE FROM tasks WHERE id=$1',[original.task]);
    const deleted=await repository.operatorPerformance(admin,{});
    assert.equal(deleted.summary.COPY.firstPass.rate,.75,'minimal history survives task deletion');
    assert.equal(deleted.people.items.find(row=>row.accountId===b.userId).COPY.recheck.rate,1);
    const removedDetails=await repository.operatorPerformance(admin,{snapshotToken:deleted.snapshotToken,metric:'recheck'},{kind:'detail',accountId:b.userId});
    assert.equal(removedDetails.items[0].canOpen,false);
    assert.equal(removedDetails.items[0].reviewRound,2,'inspection ancestry survives deletion');
    assert.equal(removedDetails.items[0].returnRound,1);
    const own=await repository.personalWorkspace(b,{},true);
    assert.equal(own.annotation.COPY.firstRecheck.rate,1,'personal and admin use the same preserved history');
    const ownHistory=await repository.personalWorkspace(b,{mode:'QUALITY',qualityRecheck:'1'});
    assert.equal(ownHistory.total,1,'deleted content remains auditable in personal history');
    assert.equal(ownHistory.items[0].canOpen,false);assert.equal(ownHistory.items[0].state,'HISTORY_ONLY');
    assert.equal(ownHistory.items[0].personalHistory[0].reviewRound,2);
    // A batch event can carry a trigger item ID. It must still record every
    // affected member, dated by the batch event rather than old sample creation.
    const affected=tasks.slice(6).map(row=>row.item);
    await db.query("UPDATE copy_sampling_items SET status='BATCH_AFFECTED',created_at=now()-interval '60 days' WHERE id=ANY($1::bigint[])",[affected]);
    await db.query(`INSERT INTO copy_sampling_events(freeze_id,sampling_item_id,action,actor_account_id,actor_username,request_id)
      VALUES($1,$2,'RETURN_BATCH',$3,'perf-admin',$4)`,[freeze,tasks[0].item,admin.userId,randomUUID()]);
    const batchReport=await repository.operatorPerformance(admin,{});
    assert.equal(batchReport.summary.batchAffected,4);
    assert.equal(batchReport.summary.qa.batchImpactReturns,4,'legacy batch without details recovers four affected members');
    assert.equal(batchReport.summary.qa.unknownBatchCounts,0);
    const legacyBatch=await repository.operatorPerformance(admin,
      {snapshotToken:batchReport.snapshotToken,metric:'qaBatch'},{kind:'detail',accountId:admin.userId});
    assert.equal(legacyBatch.items[0].affectedCount,4);
    assert.equal(legacyBatch.items[0].affectedCountRecovered,true);
    assert.equal(batchReport.summary.COPY.firstPass.rate,.75,'batch-affected members are not fabricated failed samples');
    const extraFreeze=Number((await db.query(`INSERT INTO copy_sampling_freezes(public_id,production_batch_id,freeze_version,policy_version,rate_bps,seed,algorithm_version,blind_review_enabled,population_count,sample_count,snapshot_sha256,frozen_by_username,request_id,request_fingerprint)
      VALUES($1,$2,3,1,10000,'test','test',false,2,2,$3,'perf-admin',$4,$5) RETURNING id`,[randomUUID(),batch,'d'.repeat(64),randomUUID(),'e'.repeat(64)])).rows[0].id);
    for(const [index,reviewerId,metadata] of [[4,admin.userId,{directAdminApproval:true}],[5,a.userId,{}]]) {
      const item=tasks[index];
      const sample=Number((await db.query(`INSERT INTO copy_sampling_items(public_id,freeze_id,task_id,approval_event_id,copy_revision_id,content_sha256,final_approver_account_id,final_approver_username,rank_hash,selected,status,reviewed_at,reviewed_by_account_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,'perf-a',$6,true,'PASSED',now(),$8) RETURNING id`,[randomUUID(),extraFreeze,item.task,item.approval,item.revision,'f'.repeat(64),a.userId,reviewerId])).rows[0].id);
      await db.query(`INSERT INTO copy_sampling_events(freeze_id,sampling_item_id,action,actor_account_id,actor_username,request_id,details)
        VALUES($1,$2,'PASS',$3,'test-reviewer',$4,$5)`,[extraFreeze,sample,reviewerId,randomUUID(),metadata]);
    }
    const excluded=await repository.operatorPerformance(admin,{});
    assert.equal(excluded.summary.COPY.firstPass.rate,.75);
    assert.equal(excluded.dataQuality.excluded.find(item=>item.reason==='ADMIN_DIRECT').count,1);
    assert.equal(excluded.dataQuality.excluded.find(item=>item.reason==='SELF_REVIEW').count,1);
    // Two real failures in one stage/chain suggest reassignment only while the
    // same producer still owns the open work. The second failure is outside the
    // selected period but current actionability must remain visible.
    const followup=tasks[2];
    let parent=followup.item;
    for(let round=2;round<=3;round++) {
      const revision=Number((await db.query(`INSERT INTO copy_revisions(task_id,revision,content,revision_origin,parent_revision_id)
        VALUES($1,$2,'{}','QA_RETURN',$3) RETURNING id`,[followup.task,round,followup.revision])).rows[0].id);
      await db.query('UPDATE tasks SET current_copy_revision_id=$2 WHERE id=$1',[followup.task,revision]);
      const approval=Number((await db.query(`INSERT INTO copy_approval_events(task_id,copy_revision_id,approval_mode,approved_by_account_id,approved_by_username,content_sha256)
        VALUES($1,$2,'MANUAL',$3,'perf-a',$4) RETURNING id`,[followup.task,revision,a.userId,'a'.repeat(64)])).rows[0].id);
      const item=Number((await db.query(`INSERT INTO copy_sampling_items(public_id,freeze_id,task_id,approval_event_id,copy_revision_id,content_sha256,final_approver_account_id,final_approver_username,rank_hash,selected,status,sample_kind,parent_item_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,'perf-a',$6,true,'RETURNED','MANDATORY_RECHECK',$8) RETURNING id`,[randomUUID(),extraFreeze,followup.task,approval,revision,'f'.repeat(64),a.userId,parent])).rows[0].id);
      await db.query(`INSERT INTO copy_sampling_events(freeze_id,sampling_item_id,action,actor_account_id,actor_username,request_id)
        VALUES($1,$2,'RETURN_SINGLE',$3,'perf-admin',$4)`,[extraFreeze,item,admin.userId,randomUUID()]);
      parent=item;
    }
    const attention=await repository.operatorPerformance(admin,{period:'custom',from:'2026-01-01',to:'2026-01-01'});
    assert.equal(attention.summary.reassignSuggested,1);
    const action=await repository.operatorPerformance(admin,{snapshotToken:attention.snapshotToken,metric:'reassign'},{kind:'detail'});
    assert.equal(action.items[0].consecutiveReturns,2);assert.equal(action.items[0].reviewRound,3);
    await db.query("UPDATE tasks SET assigned_to_user_id='perf-b',assigned_at=now() WHERE id=$1",[followup.task]);
    const reassigned=await repository.operatorPerformance(admin,{});
    assert.equal(reassigned.summary.reassignSuggested,0);
    assert.equal(reassigned.people.items.find(row=>row.accountId===a.userId).repeatedReturns,1);
  }finally{await repository.pool.end();await database.stop();}
});
