import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startTemporaryPostgres18 } from './helpers/personal-postgres.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { readAccountQualityFacts } from '../src/account-quality-statistics.mjs';
import { applyMigrations, loadMigrations } from '../src/database-migrations.mjs';

test('every annotation verdict uses Beijing day, actual account, and deduplicated batch members', {
  skip:process.env.RUN_ACCOUNT_QUALITY_POSTGRES !== '1', timeout:180_000,
}, async () => {
  const database = await startTemporaryPostgres18();
  const repo = new PostgresControlPlaneRepository({ connectionString:database.connectionString });
  const db = repo.pool;
  try {
    await repo.initialize();
    const users = (await db.query(`INSERT INTO app_users(username,display_name,role,password_hash,status,copy_review_enabled,copy_qc_enabled,image_qc_enabled)
      VALUES ('aq-annotator-a','甲','USER','fake','ACTIVE',true,false,false),
        ('aq-annotator-b','乙','USER','fake','ACTIVE',true,false,false),
        ('aq-reviewer','质检','REVIEWER','fake','ACTIVE',false,true,true) RETURNING id`)).rows.map(row => Number(row.id));
    const [a,b,qa] = users;
    async function fact(key,taskId,accountId,action,at,{ sampleKind='RANDOM', source=null, establishesSample=true,
      samplingItemId=null,freezeId=null,batchTrigger=null }={}) {
      await db.query(`INSERT INTO account_quality_events(event_key,task_id,stage,account_id,action,establishes_sample,occurred_at,data)
        VALUES ($1,$2,'COPY',$3,$4,$5,$6,$7)`,[key,taskId,accountId,action,establishesSample,at,
        {sampleKind,source,batchId:77,samplingItemId,freezeId,batchTrigger,
          username:accountId===a?'aq-annotator-a':'aq-annotator-b'}]);
    }
    const first='2026-09-20T02:00:00Z', later='2026-09-21T02:00:00Z';
    await fact('a-initial-return',1001,a,'RETURN',first);
    await fact('b-rework-pass',1001,b,'PASS',later,{sampleKind:'MANDATORY_RECHECK'});
    await fact('a-first-pass',1002,a,'PASS',first);
    await fact('a-batch-return',1002,a,'RETURN',later,{source:'BATCH_RETURN'});
    await fact('a-later-pass',1002,a,'PASS','2026-09-22T02:00:00Z',{sampleKind:'MANDATORY_RECHECK'});
    await fact('a-repeat-return',1003,a,'RETURN',first);
    await fact('a-repeat-pass',1003,a,'PASS',later,{sampleKind:'MANDATORY_RECHECK'});
    await fact('a-repeat-return-again',1003,a,'RETURN','2026-09-22T03:00:00Z',{sampleKind:'MANDATORY_RECHECK'});
    await fact('a-same-day-return',1004,a,'RETURN','2026-09-20T03:00:00Z');
    await fact('a-same-day-pass',1004,a,'PASS','2026-09-20T04:00:00Z',{sampleKind:'MANDATORY_RECHECK'});
    await fact('a-same-day-first-pass',1005,a,'PASS','2026-09-20T03:00:00Z');
    await fact('a-same-day-last-return',1005,a,'RETURN','2026-09-20T04:00:00Z');
    await fact('a-boundary-return',1006,a,'RETURN','2026-09-20T15:59:00Z');
    await fact('a-boundary-pass',1006,a,'PASS','2026-09-20T16:01:00Z',{sampleKind:'MANDATORY_RECHECK'});
    await fact('a-same-day-batch-return',1007,a,'RETURN','2026-09-20T05:00:00Z',{source:'BATCH_RETURN'});
    await fact('a-same-day-batch-pass',1007,a,'PASS','2026-09-20T06:00:00Z',{sampleKind:'MANDATORY_RECHECK'});
    const batchAt='2026-09-21T05:00:00Z';
    await fact('copy-qa:8108',1008,a,'RETURN',batchAt,{samplingItemId:8108,freezeId:81});
    await fact('copy-batch-impact:8108',1008,a,'RETURN',batchAt,
      {source:'BATCH_RETURN',samplingItemId:8108,freezeId:81,batchTrigger:true});
    await fact('copy-batch-impact:8109',1009,a,'RETURN',batchAt,
      {source:'BATCH_RETURN',samplingItemId:8109,freezeId:81,batchTrigger:false});
    await fact('legacy-copy-batch-member:8109',1009,a,'RETURN',batchAt,
      {source:'BATCH_RETURN',samplingItemId:8109,freezeId:81,batchTrigger:false});
    await fact('copy-batch-impact:8110',1009,a,'RETURN','2026-09-22T06:00:00Z',
      {source:'BATCH_RETURN',samplingItemId:8110,freezeId:82,batchTrigger:false});
    await db.query(`INSERT INTO operator_performance_events(event_key,task_id,account_id,stage,kind,occurred_at,data)
      VALUES('image-batch-impact:8888',8888,$1,'IMAGE','BATCH_RETURN',$2,$3)`,
      [a,later,{username:'aq-annotator-a',batchId:77,exclusion:'BATCH_AFFECTED'}]);
    await db.query(`INSERT INTO account_quality_events(event_key,task_id,stage,account_id,
      action,establishes_sample,occurred_at,data)
      VALUES('image-batch-recovery-alt:8888',8888,'IMAGE',$1,'RETURN',true,$2,$3)`,
      [a,later,{source:'BATCH_RETURN',batchId:77,samplingItemId:8888,batchTrigger:false,
        username:'aq-annotator-a'}]);
    await db.query(`INSERT INTO quality_review_activity_events(event_key,account_id,task_id,stage,kind,occurred_at,data)
      VALUES('image-batch-action:987',$1,NULL,'IMAGE','QA_BATCH_RETURN',$2,$3)`,
      [qa,later,{batchId:77,freezeId:123,affectedCount:2}]);

    const beijingDay=day=>({start:`${day}T00:00:00+08:00`,
      end:new Date(Date.parse(`${day}T00:00:00+08:00`)+86_400_000).toISOString()});
    const all=await readAccountQualityFacts(db,{start:beijingDay('2026-09-20').start,
      end:beijingDay('2026-09-23').start});
    const verdicts=all.filter(row=>row.kind==='ANNOTATION_QUALITY');
    assert.equal(verdicts.length,20);
    assert.deepEqual(verdicts.filter(row=>row.taskId===1001).map(row=>[row.day,row.accountId,row.outcome,row.reworkPassed]),
      [['2026-09-20',a,'RETURN',false],['2026-09-21',b,'PASS',true]]);
    assert.deepEqual(verdicts.filter(row=>row.taskId===1002).map(row=>[row.day,row.outcome,row.firstPassed,row.reworkPassed,row.fromBatch]),
      [['2026-09-20','PASS',true,false,false],['2026-09-21','RETURN',false,false,true],
        ['2026-09-22','PASS',false,true,false]]);
    assert.deepEqual(verdicts.filter(row=>row.taskId===1003).map(row=>[row.day,row.outcome]),
      [['2026-09-20','RETURN'],['2026-09-21','PASS'],['2026-09-22','RETURN']]);
    assert.deepEqual(verdicts.filter(row=>row.taskId===1004).map(row=>[row.day,row.outcome,row.firstPassed,row.reworkPassed]),
      [['2026-09-20','RETURN',false,false],['2026-09-20','PASS',false,true]],
      'same-day RETURN then PASS counts two decisions');
    assert.equal(verdicts.find(row=>row.taskId===1004&&row.outcome==='PASS').at,'2026-09-20T04:00:00.000Z');
    assert.equal(verdicts.find(row=>row.taskId===1004&&row.outcome==='PASS').id,
      'annotation-quality:a-same-day-pass');
    assert.deepEqual(verdicts.filter(row=>row.taskId===1005).map(row=>[row.day,row.outcome]),
      [['2026-09-20','PASS'],['2026-09-20','RETURN']],'same-day PASS then RETURN counts both decisions');
    assert.deepEqual(verdicts.filter(row=>row.taskId===1006).map(row=>[row.day,row.outcome]),
      [['2026-09-20','RETURN'],['2026-09-21','PASS']],'Beijing midnight separates two verdict days');
    assert.deepEqual(verdicts.filter(row=>row.taskId===1007).map(row=>[row.day,row.outcome,row.reworkPassed,row.fromBatch]),
      [['2026-09-20','RETURN',false,true],['2026-09-20','PASS',true,false]],
      'batch return followed by same-day pass counts two decisions');
    assert.deepEqual(verdicts.filter(row=>row.taskId===1008).map(row=>[row.outcome,row.fromBatch]),
      [['RETURN',true]],'one batch trigger operation cannot count twice');
    assert.deepEqual(verdicts.filter(row=>row.taskId===1009).map(row=>[row.outcome,row.fromBatch]),
      [['RETURN',true],['RETURN',true]],
      'one batch operation deduplicates, while a later separate batch return counts again');
    assert.equal(verdicts.find(row=>row.taskId===8888).fromBatch,true);
    assert.equal(all.find(row=>row.kind==='ANNOTATION_UNKNOWN_BATCH').unknownCount,1);

    const firstDay=await readAccountQualityFacts(db,beijingDay('2026-09-20'));
    const secondDay=await readAccountQualityFacts(db,beijingDay('2026-09-21'));
    assert.deepEqual(firstDay.filter(row=>row.kind==='ANNOTATION_QUALITY').map(row=>row.taskId).sort((x,y)=>x-y),
      [1001,1002,1003,1004,1004,1005,1005,1006,1007,1007]);
    assert.deepEqual(secondDay.filter(row=>row.kind==='ANNOTATION_QUALITY').map(row=>row.taskId).sort((x,y)=>x-y),
      [1001,1002,1003,1006,1008,1009,8888]);
    const thirdDay=await readAccountQualityFacts(db,beijingDay('2026-09-22'));
    assert.deepEqual(thirdDay.filter(row=>row.kind==='ANNOTATION_QUALITY').map(row=>row.taskId).sort((x,y)=>x-y),
      [1002,1003,1009]);
    assert.equal(firstDay.find(row=>row.kind==='ANNOTATION_QUALITY'&&row.taskId===1002).outcome,'PASS',
      'later RETURN must not rewrite the historical day');
    assert.equal(secondDay.find(row=>row.kind==='ANNOTATION_QUALITY'&&row.taskId===1002).outcome,'RETURN',
      'later PASS must not rewrite the return day');
    const accountDay=await readAccountQualityFacts(db,{...beijingDay('2026-09-21'),accountId:a});
    assert.ok(accountDay.every(row=>row.accountId===a));
    assert.equal(accountDay.some(row=>row.kind==='ANNOTATION_UNKNOWN_BATCH'),false);
    assert.equal(accountDay.some(row=>row.kind==='ANNOTATION_QUALITY'&&row.taskId===1001),false,
      'cross-account rework belongs to the actual rework annotator');
  } finally {
    await repo.close();
    await database.stop();
  }
});

test('migration restores superseded copy batch members from the batch action without counting the trigger twice', {
  skip:process.env.RUN_ACCOUNT_QUALITY_POSTGRES !== '1', timeout:180_000,
}, async () => {
  const database=await startTemporaryPostgres18();
  const repo=new PostgresControlPlaneRepository({connectionString:database.connectionString});
  const db=repo.pool;
  try {
    const migrations=await loadMigrations();
    const client=await db.connect();
    try {await client.query('BEGIN');await applyMigrations(client,migrations.filter(row=>row.id<'0089'));await client.query('COMMIT');}
    catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    const users=(await db.query(`INSERT INTO app_users(username,display_name,role,password_hash,status,copy_review_enabled,copy_qc_enabled,image_qc_enabled)
      VALUES('aq-batch-a','甲','USER','fake','ACTIVE',true,false,false),
        ('aq-batch-b','乙','USER','fake','ACTIVE',true,false,false),
        ('aq-batch-qa','质检','REVIEWER','fake','ACTIVE',false,true,true) RETURNING id`)).rows.map(row=>Number(row.id));
    const [a,b,qa]=users;
    await db.query("INSERT INTO executor_nodes(id,name) VALUES('aq-batch-node','测试机')");
    const batch=Number((await db.query(`INSERT INTO production_batches(public_id,query_package_name,created_by_username,request_id,request_fingerprint,client_batch_code)
      VALUES($1,'测试','aq-batch-qa',$2,$3,$4) RETURNING id`,[randomUUID(),randomUUID(),'a'.repeat(64),randomUUID().replaceAll('-','')])).rows[0].id);
    const freeze=Number((await db.query(`INSERT INTO copy_sampling_freezes(public_id,production_batch_id,policy_version,rate_bps,seed,algorithm_version,
      blind_review_enabled,population_count,sample_count,snapshot_sha256,frozen_by_username,request_id,request_fingerprint)
      VALUES($1,$2,1,10000,'test','test',false,2,1,$3,'aq-batch-qa',$4,$5) RETURNING id`,
      [randomUUID(),batch,'b'.repeat(64),randomUUID(),'c'.repeat(64)])).rows[0].id);
    const items=[];
    for(const [index,accountId] of [a,b].entries()) {
      const username=index===0?'aq-batch-a':'aq-batch-b';
      const task=Number((await db.query(`INSERT INTO tasks(query,input,state,created_by_node_id,production_batch_id)
        VALUES('整批恢复','{}','COPY_QC_PENDING','aq-batch-node',$1) RETURNING id`,[batch])).rows[0].id);
      const revision=Number((await db.query(`INSERT INTO copy_revisions(task_id,revision,content,revision_origin)
        VALUES($1,1,'{}','COPY_EDIT') RETURNING id`,[task])).rows[0].id);
      const approval=Number((await db.query(`INSERT INTO copy_approval_events(task_id,copy_revision_id,approval_mode,approved_by_account_id,approved_by_username,content_sha256)
        VALUES($1,$2,'MANUAL',$3,$4,$5) RETURNING id`,[task,revision,accountId,username,'d'.repeat(64)])).rows[0].id);
      const item=(await db.query(`INSERT INTO copy_sampling_items(public_id,freeze_id,task_id,approval_event_id,copy_revision_id,
        content_sha256,final_approver_account_id,final_approver_username,rank_hash,selected,status,sample_kind)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'RANDOM') RETURNING id,public_id,task_id`,
        [randomUUID(),freeze,task,approval,revision,'e'.repeat(64),accountId,username,'f'.repeat(64),index===0,
          index===0?'RETURNED':'BATCH_AFFECTED'])).rows[0];
      items.push(item);
    }
    // Simulate a source action whose original member was later superseded
    // before an older metrics backfill observed it.
    await db.query('ALTER TABLE copy_sampling_events DISABLE TRIGGER operator_copy_qa');
    const action=(await db.query(`INSERT INTO copy_sampling_events(freeze_id,sampling_item_id,action,actor_account_id,actor_username,
      request_id,details) VALUES($1,$2,'RETURN_BATCH',$3,'aq-batch-qa',$4,$5) RETURNING created_at`,
      [freeze,items[0].id,qa,randomUUID(),{affectedCount:1,affectedItemIds:[items[1].public_id],affectedTaskIds:[Number(items[1].task_id)]}])).rows[0];
    await db.query('ALTER TABLE copy_sampling_events ENABLE TRIGGER operator_copy_qa');
    await db.query("UPDATE copy_sampling_items SET status='SUPERSEDED' WHERE id=$1",[items[1].id]);
    await db.query('SELECT capture_operator_facts($1)',[items[0].task_id]);
    assert.equal((await db.query("SELECT count(*) FROM operator_performance_events WHERE event_key=$1",[`copy-batch-impact:${items[1].id}`])).rows[0].count,'0');
    const upgrade=await db.connect();
    try {await upgrade.query('BEGIN');await applyMigrations(upgrade,migrations);await upgrade.query('COMMIT');}
    catch(error){await upgrade.query('ROLLBACK');throw error;}finally{upgrade.release();}
    const range={start:new Date(Date.parse(action.created_at)-60_000).toISOString(),
      end:new Date(Date.parse(action.created_at)+60_000).toISOString()};
    const facts=await readAccountQualityFacts(db,range);
    const member=facts.find(row=>row.kind==='ANNOTATION_QUALITY' && row.taskId===Number(items[1].task_id));
    assert.equal(member.accountId,b);assert.equal(member.finalPassed,false);assert.equal(member.fromBatch,true);
    const trigger=facts.filter(row=>row.kind==='ANNOTATION_QUALITY' && row.taskId===Number(items[0].task_id));
    assert.equal(trigger.length,1);assert.equal(trigger[0].accountId,a);
    assert.equal(facts.filter(row=>row.kind==='ANNOTATION_UNKNOWN_BATCH').length,0);
    // An alternate historical source key can overlap the member recovered by
    // migration. The same freeze/member/operation is still one QA return.
    await db.query(`INSERT INTO operator_performance_events(event_key,task_id,account_id,stage,kind,occurred_at,data)
      VALUES($1,$2,$3,'COPY','BATCH_RETURN',$4,$5)`,
      [`copy-batch-source-alt:${items[1].id}`,Number(items[1].task_id),b,action.created_at,
        {batchId:batch,exclusion:'BATCH_AFFECTED',username:'aq-batch-b'}]);
    const overlap=await readAccountQualityFacts(db,range);
    const memberOverlap=overlap.filter(row=>row.kind==='ANNOTATION_QUALITY'
      && row.taskId===Number(items[1].task_id));
    assert.equal(memberOverlap.length,1,JSON.stringify(memberOverlap.map(row=>({id:row.id,at:row.at,
      source:row.source,samplingItemId:row.samplingItemId,freezeId:row.freezeId}))));
    const movedBatch=Number((await db.query(`INSERT INTO production_batches(public_id,query_package_name,
      created_by_username,request_id,request_fingerprint,client_batch_code)
      VALUES($1,'已迁入','aq-batch-qa',$2,$3,$4) RETURNING id`,
      [randomUUID(),randomUUID(),'a'.repeat(64),randomUUID().replaceAll('-','')])).rows[0].id);
    await db.query('UPDATE tasks SET production_batch_id=$1 WHERE id=$2',[movedBatch,items[1].task_id]);
    const historicalBatch=await readAccountQualityFacts(db,{...range,batchId:batch});
    assert.equal(historicalBatch.filter(row=>row.kind==='ANNOTATION_QUALITY'
      && row.taskId===Number(items[1].task_id)).length,1);
    assert.equal(historicalBatch.find(row=>row.kind==='ANNOTATION_QUALITY'
      && row.taskId===Number(items[1].task_id)).batchId,batch,
    'historical verdict keeps its event batch after the task moves to another batch');
  } finally {await repo.close();await database.stop();}
});
