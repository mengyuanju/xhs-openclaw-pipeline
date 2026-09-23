import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, access, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { startTemporaryPostgres18 } from './helpers/personal-postgres.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { applyMigrations, loadMigrations } from '../src/database-migrations.mjs';
import { readAccountQualityFacts } from '../src/account-quality-statistics.mjs';
import { summarizeAccountQuality } from '../../src/account-quality-statistics.mjs';
import { PERFORMANCE_VERSION } from '../../src/operator-performance.mjs';

test('secondary assignment migrates existing states and preserves QA subjects while resetting content', {
  skip:process.env.RUN_SECONDARY_ASSIGNMENT_POSTGRES!=='1', timeout:180000,
},async()=>{
  const database=await startTemporaryPostgres18();
  const repo=new PostgresControlPlaneRepository({connectionString:database.connectionString});
  const db=repo.pool;
  const storage=await mkdtemp(join(tmpdir(),'xhs-secondary-assets-'));
  try {
    const migrations=await loadMigrations(),client=await db.connect();
    try {await client.query('BEGIN');await applyMigrations(client,migrations.filter(m=>m.id<'0086'));await client.query('COMMIT');}finally{client.release();}
    const users=(await db.query(`INSERT INTO app_users(username,display_name,role,password_hash,status,copy_review_enabled,copy_qc_enabled,image_qc_enabled,created_at)
      VALUES('sa-a','甲','USER','fake','ACTIVE',true,false,false,now()-interval '10 days'),
      ('sa-b','乙','USER','fake','ACTIVE',true,false,false,now()-interval '10 days'),
      ('sa-qa','质检','REVIEWER','fake','ACTIVE',false,true,true,now()-interval '10 days'),
      ('sa-admin','管理员','ADMIN','fake','ACTIVE',true,true,true,now()-interval '10 days') RETURNING *`)).rows;
    const [a,b,qa,admin]=users.map(u=>({userId:Number(u.id),username:u.username,role:u.role,credentialVersion:Number(u.credential_version)}));
    await db.query("INSERT INTO executor_nodes(id,name) VALUES('sa-node','测试机')");
    const baseline={copy:{title:'机器标题',body:'先清理不再使用的物品，再按照使用频率划分区域。'.repeat(20),tags:['机器']},imagePlan:[{kind:'hero',headline:'桌面整理',subtitle:'',bullets:['清空桌面'],prompt:'自然光整洁桌面场景'}, {kind:'steps',headline:'先做减法',subtitle:'',bullets:['判断使用频率'],prompt:'物品分类与筛选过程'}, {kind:'summary',headline:'固定位置',subtitle:'',bullets:['每天复位'],prompt:'整洁桌面标签收纳区域'}]};
    async function fixture({initial=true,mandatory=true,machineReviewNull=false}={}) {
      const batch=Number((await db.query(`INSERT INTO production_batches(public_id,query_package_name,created_by_username,request_id,request_fingerprint,client_batch_code)
        VALUES($1,'二次分配测试','sa-admin',$2,$3,$4) RETURNING id`,[randomUUID(),randomUUID(),'a'.repeat(64),randomUUID().replaceAll('-','')])).rows[0].id);
      const task=Number((await db.query(`INSERT INTO tasks(query,input,state,created_by_node_id,created_by_user_id,assigned_to_user_id,assigned_at,assignment_source,production_batch_id)
        VALUES('测试数据','{}','COPY_REVIEW_PENDING','sa-node','sa-a','sa-a',now(),'MANUAL',$1) RETURNING id`,[batch])).rows[0].id);
      let original=null;
      if(initial) {
        const executionId=randomUUID();
        await db.query(`INSERT INTO task_executions(id,task_id,kind,node_id,status,stage,snapshot)
          VALUES($1,$2,'COPY','sa-node','SUCCEEDED','COMPLETED','{}')`,[executionId,task]);
        original=Number((await db.query(`INSERT INTO copy_revisions(task_id,execution_id,revision,content,revision_origin)
          VALUES($1,$2,1,$3,'GENERATION') RETURNING id`,[task,executionId,machineReviewNull?{...baseline,manualReview:null}:baseline])).rows[0].id);
      }
      const revision=Number((await db.query(`INSERT INTO copy_revisions(task_id,revision,content,revision_origin,parent_revision_id,approved_at,copy_content_changed_from_machine)
        VALUES($1,2,$2,'COPY_EDIT',$3,now(),true) RETURNING id`,[task,{copy:{title:'人工改稿',body:'删除我'}},original])).rows[0].id);
      await db.query(`UPDATE tasks SET current_copy_revision_id=$2,mandatory_copy_qc=$3,mandatory_copy_qc_origin=CASE WHEN $3 THEN 'QA_RETURN' END,state='COPY_QC_PENDING' WHERE id=$1`,[task,revision,mandatory]);
      const approval=Number((await db.query(`INSERT INTO copy_approval_events(task_id,copy_revision_id,approval_mode,approved_by_account_id,approved_by_username,content_sha256)
        VALUES($1,$2,'MANUAL',$3,'sa-a',$4) RETURNING id`,[task,revision,a.userId,'c'.repeat(64)])).rows[0].id);
      const freeze=Number((await db.query(`INSERT INTO copy_sampling_freezes(public_id,production_batch_id,policy_version,rate_bps,seed,algorithm_version,blind_review_enabled,population_count,sample_count,snapshot_sha256,frozen_by_username,request_id,request_fingerprint)
        VALUES($1,$2,1,10000,'test','test',true,1,1,$3,'sa-admin',$4,$5) RETURNING id`,[randomUUID(),batch,'d'.repeat(64),randomUUID(),'e'.repeat(64)])).rows[0].id);
      const item=(await db.query(`INSERT INTO copy_sampling_items(public_id,freeze_id,task_id,approval_event_id,copy_revision_id,content_sha256,final_approver_account_id,final_approver_username,rank_hash,selected,status,sample_kind)
        VALUES($1,$2,$3,$4,$5,$6,$7,'sa-a',$6,true,'PENDING',$8) RETURNING *`,[randomUUID(),freeze,task,approval,revision,'f'.repeat(64),a.userId,mandatory?'MANDATORY_RECHECK':'RANDOM'])).rows[0];
      return {task,original,revision,item,batch};
    }
    const legacy=await fixture({machineReviewNull:true}),missing=await fixture({initial:false}),ordinary=await fixture({mandatory:false});
    const uncertain=await fixture();
    await db.query("UPDATE copy_revisions SET content=content||'{\"manualReview\":{\"imagePlanEdited\":true}}'::jsonb WHERE id=$1",[uncertain.original]);
    await db.query('UPDATE copy_sampling_items SET freeze_id=$2 WHERE id=$1',[ordinary.item.id,legacy.item.freeze_id]);
    await db.query('UPDATE copy_sampling_freezes SET population_count=2,sample_count=2 WHERE id=$1',[legacy.item.freeze_id]);
    for(const state of ['COPY_QUEUED','COPY_RUNNING','COPY_REVIEW_PENDING','COPY_FAILED','IMAGE_QUEUED','IMAGE_RUNNING','IMAGE_FAILED','MANUAL_ARCHIVE','IMAGE_QC_PENDING','IMAGE_REWORK_PENDING','REVIEWED','CANCELLED']) {
      await db.query("INSERT INTO tasks(query,input,state,created_by_node_id) VALUES('存量状态迁移','{}',$1,'sa-node')",[state]);
    }
    await db.query("INSERT INTO operator_performance_events(event_key,task_id,account_id,stage,kind,occurred_at,data) VALUES('legacy-verdict',$1,$2,'COPY','QUALITY',clock_timestamp()-interval '1 day',$3)",[legacy.task,a.userId,{username:a.username,reviewerId:qa.userId,outcome:'RETURN',samplingItemId:Number(legacy.item.id),first:true,sampleKind:'RANDOM',batchId:legacy.batch}]);
    const before=(await db.query('SELECT id,state,current_copy_revision_id,assigned_to_user_id FROM tasks ORDER BY id')).rows;
    const oldUpgrade=await db.connect();
    try {await oldUpgrade.query('BEGIN');await applyMigrations(oldUpgrade,migrations.filter(m=>m.id<'0088'));await oldUpgrade.query('COMMIT');}
    finally {oldUpgrade.release();}
    assert.equal((await db.query('SELECT count(*) FROM task_initial_baselines WHERE task_id=$1',[legacy.task])).rows[0].count,'0',
      '0086 misses real machine output with manualReview: null');
    await repo.initialize();await repo.initialize();
    assert.deepEqual((await db.query('SELECT id,state,current_copy_revision_id,assigned_to_user_id FROM tasks ORDER BY id')).rows,before,'upgrade does not move or reset existing tasks');
    assert.equal((await db.query('SELECT count(*) FROM task_initial_baselines')).rows[0].count,'2');
    const repairedBaseline=(await db.query('SELECT * FROM task_initial_baselines WHERE task_id=$1',[legacy.task])).rows[0];
    assert.equal(repairedBaseline.source,'BACKFILL');
    assert.equal(Number(repairedBaseline.source_revision_id),legacy.original);
    assert.deepEqual(repairedBaseline.content,{...baseline,manualReview:null});
    assert.equal((await db.query('SELECT count(*) FROM task_initial_baselines WHERE task_id=$1',[uncertain.task])).rows[0].count,'0','legacy manual content cannot be treated as an original draft');
    const freshTask=Number((await db.query("INSERT INTO tasks(query,input,state,created_by_node_id) VALUES('新机器稿','{}','COPY_RUNNING','sa-node') RETURNING id")).rows[0].id);
    const freshExecution=randomUUID();
    await db.query("INSERT INTO task_executions(id,task_id,kind,node_id,status,stage,snapshot) VALUES($1,$2,'COPY','sa-node','RUNNING','COPY_RUNNING','{}')",[freshExecution,freshTask]);
    await db.query("INSERT INTO copy_revisions(task_id,execution_id,revision,content,revision_origin) VALUES($1,$2,1,$3,'GENERATION')",[freshTask,freshExecution,{...baseline,manualReview:null}]);
    assert.equal((await db.query('SELECT source FROM task_initial_baselines WHERE task_id=$1',[freshTask])).rows[0].source,'GENERATION',
      'new machine output with manualReview: null is captured before its execution is marked successful');
    const manualTask=Number((await db.query("INSERT INTO tasks(query,input,state,created_by_node_id) VALUES('人工标注','{}','COPY_RUNNING','sa-node') RETURNING id")).rows[0].id);
    const manualExecution=randomUUID();
    await db.query("INSERT INTO task_executions(id,task_id,kind,node_id,status,stage,snapshot) VALUES($1,$2,'COPY','sa-node','RUNNING','COPY_RUNNING','{}')",[manualExecution,manualTask]);
    await db.query("INSERT INTO copy_revisions(task_id,execution_id,revision,content,revision_origin) VALUES($1,$2,1,$3,'GENERATION')",[manualTask,manualExecution,{...baseline,manualReview:{imagePlanEdited:true}}]);
    assert.equal((await db.query('SELECT count(*) FROM task_initial_baselines WHERE task_id=$1',[manualTask])).rows[0].count,'0',
      'non-null manualReview is never captured as a machine baseline');
    const unprovenTask=Number((await db.query("INSERT INTO tasks(query,input,state,created_by_node_id) VALUES('无来源稿','{}','COPY_REVIEW_PENDING','sa-node') RETURNING id")).rows[0].id);
    await db.query("INSERT INTO copy_revisions(task_id,revision,content,revision_origin) VALUES($1,1,$2,'GENERATION')",[unprovenTask,{...baseline,manualReview:null}]);
    assert.equal((await db.query('SELECT count(*) FROM task_initial_baselines WHERE task_id=$1',[unprovenTask])).rows[0].count,'0',
      'a claimed generation without a COPY execution does not establish provenance');
    await assert.rejects(repo.returnCopyQaItem(legacy.item.public_id,{requestId:randomUUID(),expectedRevisionToken:'f'.repeat(64),reasonCodes:['COPY_LOGIC'],note:'复检失败'},{actor:qa}),/强制复检/);
    const escalateInput={requestId:randomUUID(),expectedRevisionToken:'f'.repeat(64),note:'复检仍有错误'};
    await assert.rejects(repo.escalateQualityToAdmin('COPY',ordinary.item.public_id,escalateInput,{actor:qa}),/变化/);
    const receipt=await repo.escalateQualityToAdmin('COPY',legacy.item.public_id,escalateInput,{actor:qa});
    assert.deepEqual(Object.keys(receipt).sort(),['id','status'],'blind receipt does not expose case or task identity');
    assert.deepEqual(await repo.escalateQualityToAdmin('COPY',legacy.item.public_id,escalateInput,{actor:qa}),receipt,'request replay');
    await assert.rejects(repo.escalateQualityToAdmin('COPY',legacy.item.public_id,{...escalateInput,note:'篡改重放参数'},{actor:qa}),/同一请求编号/);
    assert.equal((await db.query('SELECT status FROM copy_sampling_items WHERE id=$1',[ordinary.item.id])).rows[0].status,'PENDING','detaching one task never passes an unrelated pending member');
    assert.equal((await db.query('SELECT status FROM copy_sampling_freezes WHERE id=$1',[legacy.item.freeze_id])).rows[0].status,'INSPECTING');
    const pending=await repo.listReassignmentCases({}, {actor:admin});
    assert.equal((await repo.listReassignmentCases({offset:100},{actor:admin})).total,pending.total,'empty page retains the real total');
    const record=pending.items[0];assert.equal(record.canAssign,true);
    const reset=(await db.query('SELECT * FROM tasks WHERE id=$1',[legacy.task])).rows[0];
    assert.equal(reset.state,'PENDING_SECOND_ASSIGNMENT');assert.equal(reset.assigned_to_user_id,null);assert.equal(reset.mandatory_image_qc,true);
    assert.deepEqual((await db.query('SELECT content FROM copy_revisions WHERE id=$1',[reset.current_copy_revision_id])).rows[0].content,{...baseline,manualReview:null});
    assert.deepEqual((await db.query('SELECT content FROM copy_revisions WHERE id=$1',[legacy.revision])).rows[0].content,{});
    await assert.rejects(db.query("UPDATE copy_revisions SET content='{\"restore\":true}' WHERE id=$1",[legacy.revision]),/immutable|cannot be restored/);
    await assert.rejects(db.query("UPDATE tasks SET state='COPY_REVIEW_PENDING' WHERE id=$1",[legacy.task]),/administrator/);
    await assert.rejects(repo.disposeReassignmentCase(record.id,{requestId:randomUUID(),expectedVersion:1,note:'越权',targetAccountId:b.userId},{actor:a,operation:'REASSIGN'}),/管理员/);
    const countBefore=(await db.query('SELECT * FROM account_quality_records WHERE task_id=$1',[legacy.task])).rows;
    assert.equal(countBefore.length,1);assert.equal(countBefore[0].current_bucket,'RETURNED');
    await repo.disposeReassignmentCase(record.id,{requestId:randomUUID(),expectedVersion:1,note:'重新制作',targetAccountId:b.userId},{actor:admin,operation:'REASSIGN'});
    const assigned=(await db.query('SELECT * FROM tasks WHERE id=$1',[legacy.task])).rows[0];
    assert.equal(assigned.state,'COPY_REVIEW_PENDING');assert.equal(assigned.assigned_to_user_id,b.username);
    const afterA=(await db.query('SELECT * FROM account_quality_records WHERE task_id=$1',[legacy.task])).rows;
    assert.equal(afterA.length,1);assert.equal(afterA[0].operator_account_id,String(a.userId));assert.equal(afterA[0].reassigned,true);
    assert.deepEqual(afterA[0].first_qa_at,countBefore[0].first_qa_at);
    const reviewed=await repo.approveCopy(legacy.task,{revisionId:Number(assigned.current_copy_revision_id),nodeId:'sa-node',decision:'APPROVE',score:3,originalScore:3,reviewSessionId:randomUUID()},{actor:b});
    assert.equal(reviewed.state,'COPY_QC_PENDING','secondary assignment cannot bypass QA');
    const bItem=(await db.query('SELECT * FROM copy_sampling_items WHERE task_id=$1 ORDER BY id DESC LIMIT 1',[legacy.task])).rows[0];
    assert.equal(bItem.sample_kind,'MANDATORY_RECHECK');assert.equal(bItem.parent_item_id,null);
    assert.equal(Number(bItem.final_approver_account_id),b.userId);
    await assert.rejects(repo.adminDirectApproveCopyQa(legacy.task,{requestId:randomUUID(),expectedCopyRevisionId:Number(bItem.copy_revision_id),note:'尝试快捷直放'},{actor:admin}),/强制复检/);
    await repo.passCopyQaItem(bItem.public_id,{requestId:randomUUID(),expectedRevisionToken:bItem.content_sha256},{actor:qa});
    assert.equal((await db.query('SELECT state FROM tasks WHERE id=$1',[legacy.task])).rows[0].state,'IMAGE_QUEUED');
    assert.equal((await db.query('SELECT count(*) FROM account_quality_records WHERE task_id=$1',[legacy.task])).rows[0].count,'2');
    const missingReceipt=await repo.escalateQualityToAdmin('COPY',missing.item.public_id,{...escalateInput,requestId:randomUUID()},{actor:admin});
    const blocked=await repo.getReassignmentCase(missingReceipt.caseId,{actor:admin});
    assert.equal(blocked.resetStatus,'BLOCKED');assert.equal(blocked.canAssign,false);
    assert.notDeepEqual((await db.query('SELECT content FROM copy_revisions WHERE id=$1',[missing.revision])).rows[0].content,{});
    await assert.rejects(repo.disposeReassignmentCase(blocked.id,{requestId:randomUUID(),expectedVersion:1,note:'错误分配',targetAccountId:b.userId},{actor:admin,operation:'REASSIGN'}),/尚未完成/);
    await repo.disposeReassignmentCase(blocked.id,{requestId:randomUUID(),expectedVersion:1,note:'最终不能使用'},{actor:admin,operation:'DISCARD'});
    const discarded=(await db.query('SELECT * FROM account_quality_records WHERE task_id=$1',[missing.task])).rows[0];
    assert.equal(discarded.current_bucket,'DISCARDED');
    const facts=await readAccountQualityFacts(db,{start:new Date(Date.now()-3*86400000).toISOString(),end:new Date(Date.now()+86400000).toISOString()});
    const totals=summarizeAccountQuality(facts);assert.equal(totals.judged,3);assert.equal(totals.tasks,2);
    assert.equal(totals.discarded+totals.firstPassed+totals.returned,totals.judged);
    assert.equal(Math.round((totals.discardedRate+totals.firstPassRate+totals.returnRate)*10000),10000);
    const report=await repo.operatorPerformance(admin,{});assert.equal(report.metricVersion,PERFORMANCE_VERSION);assert.equal(report.summary.COPY.qualityOutcomes.judged,3);
    const detail=await repo.operatorPerformance(admin,{snapshotToken:report.snapshotToken,metric:'judged'},{kind:'detail',accountId:a.userId});assert.equal(detail.total,2);
    // A rejected image recheck escalation must leave the task and its media intact.
    const discardedDay=discarded.first_qa_at.toISOString().slice(0,10);
    const restoreInput={requestId:randomUUID(),expectedVersion:2,note:'管理员撤销误废弃'};
    await repo.restoreReassignmentCase(blocked.id,restoreInput,{actor:admin});
    assert.equal((await db.query('SELECT current_bucket FROM account_quality_records WHERE task_id=$1',[missing.task])).rows[0].current_bucket,'RETURNED');
    const restoredCase=await repo.getReassignmentCase(blocked.id,{actor:admin});
    assert.equal(restoredCase.status,'PENDING');
    await repo.disposeReassignmentCase(blocked.id,{requestId:randomUUID(),expectedVersion:restoredCase.version,note:'再次确认最终废弃'},{actor:admin,operation:'DISCARD'});
    assert.equal((await db.query('SELECT current_bucket FROM account_quality_records WHERE task_id=$1',[missing.task])).rows[0].current_bucket,'DISCARDED','repeated final disposition after restore still updates the bucket');
    assert.equal((await db.query('SELECT first_qa_at FROM account_quality_records WHERE task_id=$1',[missing.task])).rows[0].first_qa_at.toISOString().slice(0,10),discardedDay);
    const imageTask=await fixture();
    const run=randomUUID(),file=join(storage,'tasks',String(imageTask.task),'old.png');
    await mkdir(join(storage,'tasks',String(imageTask.task)),{recursive:true});await writeFile(file,'old image');
    await db.query("INSERT INTO image_runs(id,task_id,copy_revision_id,status,result,image_production_chain_id) VALUES($1,$2,$3,'COMPLETED','{}',$1)",[run,imageTask.task,imageTask.revision]);
    const asset=(await db.query("INSERT INTO assets(task_id,image_run_id,media_type,byte_size,sha256,storage_path,image_production_chain_id,origin_image_run_id,artifact_key) VALUES($1,$2,'image/png',9,$3,$4,$2,$2,'test') RETURNING id",[imageTask.task,run,'a'.repeat(64),file])).rows[0];
    await db.query("UPDATE image_runs SET result=$2 WHERE id=$1",[run,{images:[{assetId:Number(asset.id)}]}]);
    await db.query("UPDATE tasks SET state='IMAGE_QC_PENDING',current_image_run_id=$2,mandatory_image_qc=true,mandatory_image_qc_origin='QA_RETURN' WHERE id=$1",[imageTask.task,run]);
    const imageApproval=(await db.query("INSERT INTO image_approval_events(task_id,copy_revision_id,image_run_id,submitted_by_account_id,submitted_by_username,review_session_id,image_set_sha256,submission_mode) VALUES($1,$2,$3,$4,'sa-a',$5,$6,'MANDATORY_RECHECK') RETURNING id",[imageTask.task,imageTask.revision,run,a.userId,randomUUID(),'b'.repeat(64)])).rows[0];
    const imageFreeze=(await db.query("INSERT INTO image_sampling_freezes(public_id,production_batch_id,policy_version,rate_bps,seed,algorithm_version,blind_review_enabled,submitter_account_id,population_count,sample_count,snapshot_sha256,frozen_by_account_id,frozen_by_username,request_id,close_reason) VALUES($1,$2,1,10000,'test','test',true,$3,1,1,$4,$5,'sa-admin',$6,'MANDATORY_RECHECK') RETURNING id",[randomUUID(),imageTask.batch,a.userId,'c'.repeat(64),admin.userId,randomUUID()])).rows[0];
    const imageItem=(await db.query("INSERT INTO image_sampling_items(public_id,freeze_id,task_id,approval_event_id,copy_revision_id,image_run_id,image_set_sha256,submitter_account_id,submitter_username,rank_hash,selected,sample_kind,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'sa-a',$7,true,'MANDATORY_RECHECK','PENDING') RETURNING *",[randomUUID(),imageFreeze.id,imageTask.task,imageApproval.id,imageTask.revision,run,'b'.repeat(64),a.userId])).rows[0];
    await db.query("INSERT INTO image_edit_requests(id,task_id,request_id,source_image_run_id,source_asset_id,copy_revision_id,source_sha256,target_page,operation,config,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,1,'TEXT','{}','DRAFT','sa-a')",[randomUUID(),imageTask.task,randomUUID(),run,asset.id,imageTask.revision,'a'.repeat(64)]);
    const imageTaskBefore=(await db.query('SELECT state,current_stage,assigned_to_user_id,current_copy_revision_id,current_image_run_id,mandatory_image_qc,mandatory_image_qc_origin,work_generation FROM tasks WHERE id=$1',[imageTask.task])).rows[0];
    await assert.rejects(repo.escalateQualityToAdmin('IMAGE',imageItem.public_id,{requestId:randomUUID(),expectedRevisionToken:'b'.repeat(64),note:'仍有图片错误'},{actor:admin,storageRoot:storage}),
      {code:'IMAGE_RECHECK_RETURN_REQUIRED',message:/图片强制复检请继续打回返修/});
    assert.deepEqual((await db.query('SELECT state,current_stage,assigned_to_user_id,current_copy_revision_id,current_image_run_id,mandatory_image_qc,mandatory_image_qc_origin,work_generation FROM tasks WHERE id=$1',[imageTask.task])).rows[0],imageTaskBefore);
    assert.equal((await db.query('SELECT status FROM image_sampling_items WHERE id=$1',[imageItem.id])).rows[0].status,'PENDING');
    assert.equal((await db.query('SELECT count(*) FROM task_reassignment_cases WHERE task_id=$1',[imageTask.task])).rows[0].count,'0');
    await access(file);
    const retainedAsset=(await db.query('SELECT active,content_cleared_at FROM assets WHERE id=$1',[asset.id])).rows[0];
    assert.equal(retainedAsset.active,true);assert.equal(retainedAsset.content_cleared_at,null);
    const retainedRun=(await db.query('SELECT result,content_cleared_at FROM image_runs WHERE id=$1',[run])).rows[0];
    assert.deepEqual(retainedRun.result,{images:[{assetId:Number(asset.id)}]});assert.equal(retainedRun.content_cleared_at,null);
    assert.equal((await db.query('SELECT count(*) FROM image_edit_requests WHERE task_id=$1',[imageTask.task])).rows[0].count,'1');
    const imageReturn=await repo.returnImageQaItem(imageItem.public_id,{requestId:randomUUID(),score:2,reworkTarget:'IMAGE',problemAssetIds:[Number(asset.id)],reasonCodes:['TEXT_ERROR'],note:'图片仍有错误，继续返修'},{actor:qa});
    assert.equal(imageReturn.status,'RETURNED');
    assert.equal((await db.query('SELECT state FROM tasks WHERE id=$1',[imageTask.task])).rows[0].state,'IMAGE_REWORK_PENDING');
    // A legacy task without an original can be regenerated only inside its case.
    const toRegenerate=await fixture({initial:false});
    const regenReceipt=await repo.escalateQualityToAdmin('COPY',toRegenerate.item.public_id,{...escalateInput,requestId:randomUUID()},{actor:admin});
    await repo.regenerateReassignmentBaseline(regenReceipt.caseId,{requestId:randomUUID(),expectedVersion:1},{actor:admin});
    const execution=randomUUID();
    await db.query("INSERT INTO task_executions(id,task_id,kind,node_id,status,stage,snapshot) VALUES($1,$2,'COPY','sa-node','RUNNING','COPY_RUNNING','{}')",[execution,toRegenerate.task]);
    await db.query("UPDATE tasks SET state='COPY_RUNNING',current_execution_id=$2 WHERE id=$1",[toRegenerate.task,execution]);
    const regenerated=await repo.completeCopy(execution,baseline);
    assert.equal(regenerated.task.state,'PENDING_SECOND_ASSIGNMENT');
    assert.equal((await repo.getReassignmentCase(regenReceipt.caseId,{actor:admin})).canAssign,true);
    const version=(await repo.getReassignmentCase(regenReceipt.caseId,{actor:admin})).version;
    const concurrent=await Promise.allSettled([a,b].map(target=>repo.disposeReassignmentCase(regenReceipt.caseId,
      {requestId:randomUUID(),expectedVersion:version,note:'管理员并发分配',targetAccountId:target.userId},{actor:admin,operation:'REASSIGN'})));
    assert.equal(concurrent.filter(result=>result.status==='fulfilled').length,1,'only one concurrent disposition succeeds');
    assert.equal(concurrent.filter(result=>result.status==='rejected').length,1);
    assert.equal((await db.query('SELECT count(*) FROM task_assignment_records WHERE task_id=$1 AND ended_at IS NULL',[toRegenerate.task])).rows[0].count,'1');
  } finally {await db.end();await database.stop();assert.ok(resolve(storage).startsWith(resolve(tmpdir())+'\\xhs-secondary-assets-') || resolve(storage).startsWith(resolve(tmpdir())+'/xhs-secondary-assets-'));await rm(storage,{recursive:true,force:true});}
});
