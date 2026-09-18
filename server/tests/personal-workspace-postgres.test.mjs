import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { startTemporaryPostgres18 } from './helpers/personal-postgres.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';

test('personal workspace PostgreSQL: exact pending counts, planning result, recheck, historical reassignment and identity isolation', {
  skip:process.env.RUN_PERSONAL_WORKSPACE_POSTGRES !== '1', timeout:120_000,
}, async () => {
  const database = await startTemporaryPostgres18();
  const repository = new PostgresControlPlaneRepository({connectionString:database.connectionString});
  try {
    await repository.initialize();
    const pool = repository.pool;
    const users = (await pool.query(`INSERT INTO app_users(username,display_name,role,password_hash,status,created_at)
      VALUES ('personal-a','作业员甲','USER','test-only','ACTIVE',now()-interval '3 days'),
      ('personal-b','作业员乙','USER','test-only','ACTIVE',now()-interval '3 days') RETURNING id,username`)).rows;
    const actor = {userId:Number(users[0].id),username:users[0].username,role:'USER'};
    await pool.query("INSERT INTO executor_nodes(id,name) VALUES ('personal-test','Test')");
    const tasks = (await pool.query(`INSERT INTO tasks(query,input,state,created_by_node_id,created_by_user_id,assigned_to_user_id,assignment_source,assigned_at,created_at)
      SELECT 'personal query '||n,'{}'::jsonb,'COPY_REVIEW_PENDING','personal-test','personal-a','personal-a','MANUAL',now()-interval '1 day',now()-interval '2 days'
      FROM generate_series(1,3) n RETURNING id`)).rows.map(row=>Number(row.id));
    const revisions=[];
    for (const id of tasks) {
      const revision=Number((await pool.query("INSERT INTO copy_revisions(task_id,revision,content,revision_origin) VALUES ($1,1,'{}','GENERATION') RETURNING id",[id])).rows[0].id);
      revisions.push(revision);
      await pool.query('UPDATE tasks SET current_copy_revision_id=$2 WHERE id=$1',[id,revision]);
    }
    let report=await repository.personalWorkspace(actor,{},true);
    assert.deepEqual(report.notices,[],'all report SQL must execute on the migrated schema');
    assert.equal(report.counts.copyInitial,3);
    assert.equal(report.counts.actionable,3);
    const list=await repository.personalWorkspace(actor,{category:'copyInitial',pageSize:'2'});
    assert.equal(list.total,3); assert.equal(list.items.length,2); assert.equal(list.items[0].canOpen,true);
    const second=await repository.personalWorkspace(actor,{category:'copyInitial',pageSize:'2',page:'2'});
    assert.equal(second.items.length,1); assert.notEqual(second.items[0].id,list.items[0].id);
    await pool.query(`INSERT INTO copy_approval_events(task_id,copy_revision_id,approval_mode,approved_by_account_id,approved_by_username,content_sha256)
      VALUES ($1,$2,'MANUAL',$3,'personal-a',$4)`,[tasks[0],revisions[0],actor.userId,'a'.repeat(64)]);
    const returned=Number((await pool.query(`INSERT INTO copy_revisions(task_id,revision,content,revision_origin,parent_revision_id)
      VALUES ($1,2,'{"qualityReturn":{"reasonCodes":["TEXT_ERROR"],"note":"更正错字"}}','QA_RETURN',$2) RETURNING id`,[tasks[0],revisions[0]])).rows[0].id);
    await pool.query(`UPDATE tasks SET current_copy_revision_id=$2,mandatory_copy_qc=true,mandatory_copy_qc_origin='QA_RETURN',queue_entered_at=now()-interval '25 hours' WHERE id=$1`,[tasks[0],returned]);
    await pool.query("UPDATE tasks SET personal_stage_entered_at=now()-interval '25 hours' WHERE id=$1",[tasks[0]]);
    report=await repository.personalWorkspace(actor,{},true);
    assert.equal(report.counts.rework,1); assert.equal(report.rework.longWaiting,1);
    assert.equal(report.period.returned,1); assert.equal(report.period.copy,1);
    const waitingBefore=(await pool.query('SELECT personal_stage_entered_at FROM tasks WHERE id=$1',[tasks[0]])).rows[0].personal_stage_entered_at;
    await pool.query('UPDATE tasks SET updated_at=now(),last_activity_at=now(),queue_entered_at=now() WHERE id=$1',[tasks[0]]);
    assert.deepEqual((await pool.query('SELECT personal_stage_entered_at FROM tasks WHERE id=$1',[tasks[0]])).rows[0].personal_stage_entered_at,waitingBefore);
    const job=randomUUID();
    await pool.query(`INSERT INTO copy_image_plan_regeneration_jobs(id,request_id,task_id,copy_revision_id,requested_by_account_id,requested_by_username,copy_payload,status)
      VALUES ($1,$2,$3,$4,$5,'personal-a','{}','RUNNING')`,[job,randomUUID(),tasks[0],returned,actor.userId]);
    report=await repository.personalWorkspace(actor,{},true);
    assert.equal(report.rework.processing,1); assert.equal(report.counts.actionable,2);
    await pool.query("UPDATE copy_image_plan_regeneration_jobs SET status='SUCCEEDED',finished_at=now() WHERE id=$1",[job]);
    report=await repository.personalWorkspace(actor,{},true);
    assert.equal(report.rework.confirm,1); assert.equal(report.background.previews,1); assert.equal(report.rework.longWaiting,0);
    await pool.query(`INSERT INTO copy_approval_events(task_id,copy_revision_id,approval_mode,approved_by_account_id,approved_by_username,content_sha256)
      VALUES ($1,$2,'MANUAL',$3,'personal-a',$4)`,[tasks[0],returned,actor.userId,'a'.repeat(64)]);
    await pool.query("UPDATE tasks SET state='COPY_QC_PENDING' WHERE id=$1",[tasks[0]]);
    report=await repository.personalWorkspace(actor,{},true);
    assert.equal(report.counts.rework,0); assert.equal(report.counts.recheck,1); assert.equal(report.background.previews,0);
    assert.equal(report.period.reworked,1); assert.equal(report.period.reworkRounds,1);
    await pool.query("UPDATE tasks SET created_by_user_id='personal-b',assigned_to_user_id='personal-b',assigned_at=now() WHERE id=$1",[tasks[0]]);
    report=await repository.personalWorkspace(actor,{},true);
    assert.equal(report.counts.ALL,2); assert.equal(report.period.copy,1);
    const history=await repository.personalWorkspace(actor,{mode:'COMPLETED'});
    assert.equal(history.total,1); assert.equal(history.items[0].canOpen,false); assert.equal(history.items[0].currentCopyRevisionId,null);
    const foreign=await repository.personalWorkspace({...actor,userId:Number(users[1].id),username:'personal-b'},{mode:'COMPLETED'});
    assert.equal(foreign.total,0,'new assignee does not inherit completion credit');
    await assert.rejects(repository.personalWorkspace({...actor,userId:null},{}));

    // A resolved repair supersedes the old sample; its original return and
    // first inspection decision must remain in the operator's history.
    const imageRun=randomUUID(), imageTask=tasks[1], imageRevision=revisions[1];
    await pool.query("INSERT INTO image_runs(id,task_id,copy_revision_id,status,result,finished_at,image_production_chain_id) VALUES ($1,$2,$3,'COMPLETED','{}',now(),$1)",[imageRun,imageTask,imageRevision]);
    await pool.query("UPDATE tasks SET state='IMAGE_REWORK_PENDING',current_image_run_id=$2,mandatory_image_qc=true WHERE id=$1",[imageTask,imageRun]);
    const imageApproval=Number((await pool.query(`INSERT INTO image_approval_events(task_id,copy_revision_id,image_run_id,submitted_by_account_id,submitted_by_username,review_session_id,image_set_sha256)
      VALUES ($1,$2,$3,$4,'personal-a',$5,$6) RETURNING id`,[imageTask,imageRevision,imageRun,actor.userId,randomUUID(),'b'.repeat(64)])).rows[0].id);
    const batch=Number((await pool.query(`INSERT INTO production_batches(public_id,query_package_name,created_by_username,request_id,request_fingerprint,client_batch_code)
      VALUES ($1,'fixture','personal-a',$2,$3,$4) RETURNING id`,[randomUUID(),randomUUID(),'c'.repeat(64),'c'.repeat(32)])).rows[0].id);
    const freeze=Number((await pool.query(`INSERT INTO image_sampling_freezes(public_id,production_batch_id,policy_version,rate_bps,seed,algorithm_version,blind_review_enabled,submitter_account_id,population_count,sample_count,snapshot_sha256,frozen_by_username,request_id,close_reason)
      VALUES ($1,$2,1,10000,'fixture','fixture',false,$3,1,1,$4,'admin',$5,'MANUAL') RETURNING id`,[randomUUID(),batch,actor.userId,'d'.repeat(64),randomUUID()])).rows[0].id);
    const sample=Number((await pool.query(`INSERT INTO image_sampling_items(public_id,freeze_id,task_id,approval_event_id,copy_revision_id,image_run_id,image_set_sha256,submitter_account_id,submitter_username,rank_hash,selected,status,reason_codes,note,rework_target,reviewed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'personal-a',$7,true,'SUPERSEDED',ARRAY['TEXT_ERROR'],'图片文字有误','BOTH',now()) RETURNING id`,[randomUUID(),freeze,imageTask,imageApproval,imageRevision,imageRun,'e'.repeat(64),actor.userId])).rows[0].id);
    await pool.query(`INSERT INTO image_sampling_events(freeze_id,sampling_item_id,action,actor_username,request_id) VALUES ($1,$2,'RETURN_SINGLE','admin',$3)`,[freeze,sample,randomUUID()]);
    report=await repository.personalWorkspace(actor,{},true);
    assert.deepEqual(report.notices,[]);assert.equal(report.period.returned,2);
    assert.equal(report.quality.IMAGE.samples,1);assert.equal(report.quality.IMAGE.passed,0);
    assert.equal(report.rework.both,1);
    const asset=Number((await pool.query("INSERT INTO assets(task_id,image_run_id,media_type,byte_size,sha256,storage_path,image_production_chain_id,origin_image_run_id,artifact_key) VALUES ($1,$2,'image/png',10,$3,'fake.png',$2,$2,'fake') RETURNING id",[imageTask,imageRun,'f'.repeat(64)])).rows[0].id);
    await pool.query(`INSERT INTO image_edit_requests(id,task_id,request_id,source_image_run_id,source_asset_id,copy_revision_id,source_sha256,target_page,operation,config,status,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,1,'TEXT','{}','PREVIEW_READY','personal-a')`,[randomUUID(),imageTask,randomUUID(),imageRun,asset,imageRevision,'f'.repeat(64)]);
    report=await repository.personalWorkspace(actor,{},true);
    assert.equal(report.rework.confirm,1);assert.equal(report.background.previews,1);
    const previews=await repository.personalWorkspace(actor,{category:'previews'});
    assert.equal(previews.total,1);assert.equal(previews.items[0].id,imageTask);
  } finally { await repository.pool.end(); await database.stop(); }
});
